import "server-only"

import type { BillingModel, CostStatus, IncomeStatus, ProjectStatus } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal, sum, toBase } from "@/lib/money"
import { monthIndex, type Month } from "@/lib/period"

import { assertPeriodOpen, audit, ensurePeriod, fxRateFor, uniqueCode } from "./common"
import { inTx, prisma, type Db } from "./db"
import { COST_KINDS, INCOME_KINDS } from "./settings"

/** Statuses that count as actual revenue / cost in reports (planned and cancelled entries do not). */
export const RECOGNIZED_INCOME: IncomeStatus[] = ["INVOICED", "PARTIALLY_RECEIVED", "RECEIVED"]
export const RECOGNIZED_COST: CostStatus[] = ["INCURRED", "PAID"]

export async function listProjects(user: SessionUser, db: Db = prisma) {
  const projects = await db.project.findMany({
    where: { organizationId: user.organizationId },
    include: {
      client: true,
      department: true,
      income: { where: { status: { in: RECOGNIZED_INCOME } }, select: { baseAmount: true } },
      costs: { where: { status: { in: RECOGNIZED_COST } }, select: { baseAmount: true } },
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  })
  return projects.map(({ income, costs, ...project }) => {
    const revenue = sum(income.map((i) => new Decimal(i.baseAmount)))
    const cost = sum(costs.map((c) => new Decimal(c.baseAmount)))
    return { ...project, revenue, cost, profit: revenue.sub(cost) }
  })
}

export async function getProject(user: SessionUser, id: string, db: Db = prisma) {
  const project = await db.project.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      client: true,
      department: true,
      income: { include: { period: true, category: true }, orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { createdAt: "desc" }] },
      costs: { include: { period: true, category: true, employee: true }, orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { createdAt: "desc" }] },
    },
  })
  if (!project) throw new UserInputError("Project not found.")
  return project
}

export async function createProject(
  user: SessionUser,
  input: {
    name: string
    clientId: string | null
    newClientName: string | null
    departmentId: string | null
    billingModel: BillingModel
    currency: string
    contractValue: Decimal | null
    startDate: Date | null
    endDate: Date | null
    description: string | null
  },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    let clientId = input.clientId
    if (!clientId && input.newClientName) {
      const code = await uniqueCode(input.newClientName, async (c) =>
        Boolean(await tx.client.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })),
      )
      const client = await tx.client.create({ data: { organizationId: user.organizationId, code, name: input.newClientName } })
      await audit(tx, user, "client.create", "client", client.id, { name: input.newClientName })
      clientId = client.id
    } else if (clientId && !(await tx.client.findFirst({ where: { id: clientId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Client not found.")
    }
    if (input.departmentId && !(await tx.department.findFirst({ where: { id: input.departmentId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Department not found.")
    }
    const code = await uniqueCode(input.name, async (c) =>
      Boolean(await tx.project.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })),
    )
    const project = await tx.project.create({
      data: {
        organizationId: user.organizationId,
        code,
        name: input.name,
        clientId,
        departmentId: input.departmentId,
        billingModel: input.billingModel,
        currency: input.currency,
        contractValue: input.contractValue,
        startDate: input.startDate,
        endDate: input.endDate,
        description: input.description,
        status: "ACTIVE",
      },
    })
    await audit(tx, user, "project.create", "project", project.id, { name: input.name, code })
    return project
  })
}

export async function setProjectStatus(user: SessionUser, id: string, status: ProjectStatus, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const { count } = await tx.project.updateMany({ where: { id, organizationId: user.organizationId }, data: { status } })
    if (!count) throw new UserInputError("Project not found.")
    await audit(tx, user, "project.set_status", "project", id, { status })
  })
}

async function checkProjectAndCategory(db: Db, user: SessionUser, projectId: string, categoryId: string, kinds: string[]) {
  // Sequential: db is usually a transaction, which runs one query at a time.
  const project = await db.project.findFirst({ where: { id: projectId, organizationId: user.organizationId } })
  const category = await db.financialCategory.findFirst({ where: { id: categoryId, organizationId: user.organizationId, archivedAt: null } })
  if (!project) throw new UserInputError("Project not found.")
  if (!category || !kinds.includes(category.kind)) throw new UserInputError("Choose a valid category.")
  return project
}

// ── Project income ──

export function listIncome(user: SessionUser, filter: { month?: Month | null; projectId?: string | null } = {}, db: Db = prisma) {
  return db.projectIncome.findMany({
    where: {
      project: { organizationId: user.organizationId },
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.month ? { period: { year: filter.month.year, month: filter.month.month } } : {}),
    },
    include: { project: { include: { client: true } }, period: true, category: true },
    orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { createdAt: "desc" }],
    take: 500,
  })
}

export async function addIncome(
  user: SessionUser,
  input: {
    projectId: string
    month: Month
    categoryId: string
    description: string
    status: IncomeStatus
    amount: Decimal
    currency: string
    fxRate: Decimal | null
    invoiceNumber: string | null
    invoiceDate: Date | null
    dueDate: Date | null
    receivedAmount: Decimal | null
    receivedDate: Date | null
  },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    await checkProjectAndCategory(tx, user, input.projectId, input.categoryId, INCOME_KINDS)
    const period = await ensurePeriod(tx, user.organizationId, input.month)
    assertPeriodOpen(period, input.month)
    const fxRate = await fxRateFor(tx, user, input.currency, input.month, input.fxRate)
    const received = input.status === "RECEIVED" ? input.amount : (input.receivedAmount ?? new Decimal(0))
    if (received.gt(input.amount)) throw new UserInputError("Received amount cannot exceed the amount.")

    const income = await tx.projectIncome.create({
      data: {
        projectId: input.projectId,
        periodId: period.id,
        categoryId: input.categoryId,
        description: input.description,
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        fxRateToBase: fxRate,
        baseAmount: toBase(input.amount, fxRate),
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        receivedAmount: received,
        receivedDate: received.isPositive() ? (input.receivedDate ?? new Date()) : null,
      },
    })
    await audit(tx, user, "project_income.create", "project_income", income.id, {
      projectId: input.projectId,
      amount: input.amount.toString(),
      currency: input.currency,
      status: input.status,
    })
    return income
  })
}

/** Settlement update (allowed even after the month closes): status and received cash. */
export async function updateIncomeSettlement(
  user: SessionUser,
  id: string,
  input: { status: IncomeStatus; receivedAmount: Decimal; receivedDate: Date | null },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    const income = await tx.projectIncome.findFirst({ where: { id, project: { organizationId: user.organizationId } } })
    if (!income) throw new UserInputError("Income entry not found.")
    const amount = new Decimal(income.amount)
    const received = input.status === "RECEIVED" ? amount : input.receivedAmount
    if (received.gt(amount)) throw new UserInputError("Received amount cannot exceed the amount.")
    await tx.projectIncome.update({
      where: { id },
      data: { status: input.status, receivedAmount: received, receivedDate: received.isPositive() ? (input.receivedDate ?? new Date()) : null },
    })
    await audit(tx, user, "project_income.settle", "project_income", id, { status: input.status, receivedAmount: received.toString() })
  })
}

// ── Project costs ──

export function listCosts(user: SessionUser, filter: { month?: Month | null; projectId?: string | null } = {}, db: Db = prisma) {
  return db.projectCost.findMany({
    where: {
      project: { organizationId: user.organizationId },
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.month ? { period: { year: filter.month.year, month: filter.month.month } } : {}),
    },
    include: { project: { include: { client: true } }, period: true, category: true, employee: true },
    orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { createdAt: "desc" }],
    take: 500,
  })
}

export async function addCost(
  user: SessionUser,
  input: {
    projectId: string
    categoryId: string
    description: string
    status: "INCURRED" | "PAID" | "PLANNED"
    vendorName: string | null
    employeeId: string | null
    amount: Decimal
    currency: string
    fxRate: Decimal | null
    incurredDate: Date
    paidDate: Date | null
  },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    await checkProjectAndCategory(tx, user, input.projectId, input.categoryId, COST_KINDS)
    if (input.employeeId && !(await tx.employee.findFirst({ where: { id: input.employeeId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Employee not found.")
    }
    const month = { year: input.incurredDate.getUTCFullYear(), month: input.incurredDate.getUTCMonth() + 1 }
    const period = await ensurePeriod(tx, user.organizationId, month)
    assertPeriodOpen(period, month)
    const fxRate = await fxRateFor(tx, user, input.currency, month, input.fxRate)

    const cost = await tx.projectCost.create({
      data: {
        projectId: input.projectId,
        periodId: period.id,
        categoryId: input.categoryId,
        description: input.description,
        status: input.status,
        vendorName: input.vendorName,
        employeeId: input.employeeId,
        amount: input.amount,
        currency: input.currency,
        fxRateToBase: fxRate,
        baseAmount: toBase(input.amount, fxRate),
        incurredDate: input.incurredDate,
        paidDate: input.status === "PAID" ? (input.paidDate ?? input.incurredDate) : null,
      },
    })
    await audit(tx, user, "project_cost.create", "project_cost", cost.id, {
      projectId: input.projectId,
      amount: input.amount.toString(),
      currency: input.currency,
      status: input.status,
    })
    return cost
  })
}

/** Settlement update (allowed after the month closes): mark paid or cancel. */
export async function updateCostStatus(user: SessionUser, id: string, status: CostStatus, paidDate: Date | null, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const cost = await tx.projectCost.findFirst({ where: { id, project: { organizationId: user.organizationId } } })
    if (!cost) throw new UserInputError("Cost entry not found.")
    await tx.projectCost.update({
      where: { id },
      data: { status, paidDate: status === "PAID" ? (paidDate ?? new Date()) : null },
    })
    await audit(tx, user, "project_cost.set_status", "project_cost", id, { status })
  })
}

export function isMonthInRange(m: Month, from: Month, to: Month) {
  return monthIndex(m) >= monthIndex(from) && monthIndex(m) <= monthIndex(to)
}
