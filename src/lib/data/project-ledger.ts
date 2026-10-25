import "server-only"

import type { CategoryKind, Prisma } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal, toBase } from "@/lib/money"
import { monthEnd, monthLabel, monthStart, type Month } from "@/lib/period"

import { assertPeriodOpen, audit, ensurePeriod, fxRateFor, uniqueCode, type Tx } from "./common"
import { inTx, prisma, type Db } from "./db"
import { accountByCode, postJournal, reverseJournal } from "./ledger"

/*
 * Project income and project costs on the financial workspace, grouped by department like the
 * "Project costs" / "Project income" blocks of the team's spreadsheet.
 *
 * Every row belongs to a project (that is what links it to a department and a client). Rows entered
 * without a project go to the department's internal "general" project; rows with a client but no
 * project go to a per-client project of that department. Nothing reaches the reports until the row is
 * confirmed: confirming posts it to the ledger (revenue against receivables, or expense against
 * payables); recording a payment posts the cash movement; un-confirming posts a reversal.
 *
 * Payroll is never entered here: it comes from the financial sheet, so payroll categories are not
 * offered for costs (prevents counting salaries twice).
 */

export type LedgerKind = "income" | "cost"

export const INCOME_KINDS: CategoryKind[] = ["REVENUE", "OTHER_INCOME"]
export const COST_KINDS: CategoryKind[] = ["COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_EXPENSE"]
const PAYROLL_CATEGORY_CODES = ["DELIVERY-PAYROLL", "OVERHEAD-PAYROLL"]

function requireManage(user: SessionUser) {
  if (!user.permissions.has("project_finance:manage")) throw new UserInputError("You do not have permission to record project income and costs.")
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerRow = Awaited<ReturnType<typeof getProjectLedger>>["income"][number]

export async function getProjectLedger(user: SessionUser, m: Month, db: Db = prisma) {
  const periodWhere = { period: { organizationId: user.organizationId, year: m.year, month: m.month } }
  const departments = await db.department.findMany({
    where: { organizationId: user.organizationId, archivedAt: null },
    include: { teams: { where: { archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    orderBy: { name: "asc" },
  })
  const income = await db.projectIncome.findMany({
    where: periodWhere,
    include: { project: { include: { client: true, department: true } }, category: true, team: true },
    orderBy: { createdAt: "asc" },
  })
  const costs = await db.projectCost.findMany({
    where: periodWhere,
    include: { project: { include: { client: true, department: true } }, category: true, team: true },
    orderBy: { createdAt: "asc" },
  })
  const categories = await db.financialCategory.findMany({
    where: { organizationId: user.organizationId, archivedAt: null, kind: { in: [...INCOME_KINDS, ...COST_KINDS] }, code: { notIn: PAYROLL_CATEGORY_CODES } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  })
  const clients = await db.client.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: { name: "asc" } })
  const projects = await db.project.findMany({
    where: { organizationId: user.organizationId, billingModel: { not: "INTERNAL" }, status: { notIn: ["CANCELLED"] } },
    orderBy: { name: "asc" },
  })

  const common = (r: (typeof income)[number] | (typeof costs)[number]) => ({
    id: r.id,
    departmentId: r.project.departmentId,
    item: r.description,
    amount: r.amount.toString(),
    currency: r.currency,
    baseAmount: r.baseAmount.toString(),
    categoryId: r.categoryId,
    categoryName: r.category.name,
    projectId: r.project.billingModel === "INTERNAL" ? null : r.projectId,
    projectName: r.project.billingModel === "INTERNAL" ? null : r.project.name,
    clientId: r.project.clientId,
    clientName: r.project.client?.name ?? null,
    confirmed: !!r.journalEntryId,
    notes: r.notes,
  })

  return {
    departments: departments.map((d) => ({ id: d.id, name: d.name, color: d.color, classification: d.costClassification, teams: d.teams.map((t) => ({ id: t.id, name: t.name })) })),
    income: income.map((r) => ({
      ...common(r),
      kind: "income" as const,
      date: iso(r.invoiceDate) ?? iso(monthStart(m))!,
      status: r.status as string,
      settled: r.receivedAmount.toString(),
      teamId: r.teamId,
      teamName: r.team?.name ?? null,
    })),
    costs: costs.map((r) => ({
      ...common(r),
      kind: "cost" as const,
      date: iso(r.incurredDate)!,
      status: r.status as string,
      settled: r.status === "PAID" ? r.amount.toString() : "0",
      teamId: r.teamId,
      teamName: r.team?.name ?? null,
      recurring: r.recurring,
      carried: !!r.carriedFromId,
    })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, kind: INCOME_KINDS.includes(c.kind) ? ("income" as const) : ("cost" as const) })),
    clients: clients.map((c) => ({ id: c.id, name: c.name })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, departmentId: p.departmentId, clientId: p.clientId })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerInput = {
  departmentId: string
  item: string
  amount: Decimal
  currency: string
  categoryId: string | null
  projectId: string | null
  clientId: string | null
  clientName: string | null
  teamId: string | null
  date: Date | null
  notes: string | null
  /** Costs only: a planned monthly cost offered for carrying into the next month. */
  recurring?: boolean
}

/** Resolves the project a row belongs to (see the module comment). */
async function resolveProject(tx: Tx, user: SessionUser, input: Pick<LedgerInput, "departmentId" | "projectId" | "clientId" | "clientName">) {
  const department = await tx.department.findFirst({ where: { id: input.departmentId, organizationId: user.organizationId } })
  if (!department) throw new UserInputError("Choose a department.")

  if (input.projectId) {
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId: user.organizationId } })
    if (!project) throw new UserInputError("Project not found.")
    if (project.departmentId && project.departmentId !== department.id) throw new UserInputError("That project belongs to another department.")
    return project
  }

  let clientId = input.clientId
  if (!clientId && input.clientName?.trim()) {
    const name = input.clientName.trim().slice(0, 160)
    const existing = await tx.client.findFirst({ where: { organizationId: user.organizationId, name: { equals: name, mode: "insensitive" } } })
    if (existing) clientId = existing.id
    else {
      const code = await uniqueCode(name, async (c) => Boolean(await tx.client.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })))
      clientId = (await tx.client.create({ data: { organizationId: user.organizationId, code, name } })).id
      await audit(tx, user, "client.create", "client", clientId, { name, via: "workspace" })
    }
  }

  if (clientId) {
    const client = await tx.client.findFirst({ where: { id: clientId, organizationId: user.organizationId } })
    if (!client) throw new UserInputError("Client not found.")
    const code = `CL-${client.code}-${department.code}`.slice(0, 60)
    return (
      (await tx.project.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code } } })) ??
      (await tx.project.create({
        data: { organizationId: user.organizationId, code, name: `${client.name} · ${department.name}`, clientId: client.id, departmentId: department.id, billingModel: "RETAINER", currency: user.baseCurrency, status: "ACTIVE" },
      }))
    )
  }

  const code = `DEPT-${department.code}`.slice(0, 60)
  return (
    (await tx.project.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code } } })) ??
    (await tx.project.create({
      data: { organizationId: user.organizationId, code, name: `${department.name} · general`, departmentId: department.id, billingModel: "INTERNAL", currency: user.baseCurrency, status: "ACTIVE" },
    }))
  )
}

async function resolveCategory(tx: Tx, user: SessionUser, kind: LedgerKind, categoryId: string | null, departmentId: string) {
  if (categoryId) {
    const category = await tx.financialCategory.findFirst({ where: { id: categoryId, organizationId: user.organizationId, archivedAt: null } })
    const allowed = kind === "income" ? INCOME_KINDS : COST_KINDS
    if (!category || !allowed.includes(category.kind)) throw new UserInputError("Choose a valid category.")
    if (PAYROLL_CATEGORY_CODES.includes(category.code)) throw new UserInputError("Payroll comes from the financial sheet; do not enter it as a cost.")
    return category
  }
  const department = await tx.department.findUniqueOrThrow({ where: { id: departmentId } })
  const code = kind === "income" ? "AGENCY-REVENUE" : department.costClassification === "COST_OF_SALES" ? "PRODUCTION-TOOLS" : "OTHER-OPEX"
  const category = await tx.financialCategory.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code } } })
  if (!category) throw new UserInputError("Default category is missing. Run the latest migration.")
  return category
}

function checkDate(date: Date | null, m: Month) {
  if (!date) return monthStart(m)
  if (date < monthStart(m) || date > monthEnd(m)) throw new UserInputError(`The date must be within ${monthLabel(m)}.`)
  return date
}

export async function addLedgerEntry(user: SessionUser, m: Month, kind: LedgerKind, input: LedgerInput & { allowDuplicate?: boolean }, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m, user)
    const item = input.item.trim()
    if (!item || item.length > 200) throw new UserInputError("Enter the item (max 200 characters).")
    if (input.amount.lte(0)) throw new UserInputError("Amount must be greater than zero.")
    if (!["USD", "EUR", "GBP", "USDT"].includes(input.currency)) throw new UserInputError("Choose a supported currency.")
    const project = await resolveProject(tx, user, input)
    const category = await resolveCategory(tx, user, kind, input.categoryId, input.departmentId)
    const date = checkDate(input.date, m)
    const fxRate = await fxRateFor(tx, user, input.currency, m)

    // Duplicate protection: the same item and amount for the same project in the same month.
    if (!input.allowDuplicate) {
      const where = { projectId: project.id, periodId: period.id, description: { equals: item, mode: "insensitive" as const }, amount: input.amount.toString(), currency: input.currency }
      const duplicate = kind === "income" ? await tx.projectIncome.findFirst({ where }) : await tx.projectCost.findFirst({ where: { ...where, status: { not: "CANCELLED" } } })
      if (duplicate) throw new UserInputError("DUPLICATE: a row with the same item and amount already exists this month.")
    }

    if (input.teamId && !(await tx.team.findFirst({ where: { id: input.teamId, department: { organizationId: user.organizationId } } }))) throw new UserInputError("Team not found.")

    const base = {
      projectId: project.id,
      periodId: period.id,
      categoryId: category.id,
      description: item,
      amount: input.amount.toString(),
      currency: input.currency,
      fxRateToBase: fxRate.toString(),
      baseAmount: toBase(input.amount, fxRate).toString(),
      notes: input.notes?.slice(0, 2000) || null,
    }
    const row =
      kind === "income"
        ? await tx.projectIncome.create({ data: { ...base, status: "PLANNED", invoiceDate: date, teamId: input.teamId } })
        : await tx.projectCost.create({ data: { ...base, status: "PLANNED", incurredDate: date, teamId: input.teamId, recurring: input.recurring ?? false } })
    await audit(tx, user, `project_${kind}.create`, `project_${kind}`, row.id, { item, amount: base.amount, currency: input.currency, projectId: project.id })
    return row
  })
}

async function loadRow(tx: Tx, user: SessionUser, kind: LedgerKind, id: string) {
  const where = { id, project: { organizationId: user.organizationId } }
  const row = kind === "income" ? await tx.projectIncome.findFirst({ where, include: { project: true, category: true, period: true } }) : await tx.projectCost.findFirst({ where, include: { project: true, category: true, period: true } })
  if (!row) throw new UserInputError("Row not found.")
  return row
}

export async function updateLedgerEntry(user: SessionUser, kind: LedgerKind, id: string, input: Partial<LedgerInput>, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const row = await loadRow(tx, user, kind, id)
    const m = { year: row.period.year, month: row.period.month }
    assertPeriodOpen(row.period, m, user)
    // Notes and the recurring flag are labels: they can change on a confirmed row.
    const onlyNotes = Object.keys(input).every((k) => k === "notes" || k === "recurring")
    if (row.journalEntryId && !onlyNotes) throw new UserInputError("This row is confirmed. Un-confirm it to change it (a reversal is posted).")

    const data: Record<string, unknown> = {}
    if (input.notes !== undefined) data.notes = input.notes?.slice(0, 2000) || null
    if (kind === "cost" && input.recurring !== undefined) data.recurring = input.recurring
    if (!onlyNotes) {
      const departmentId = input.departmentId ?? row.project.departmentId
      if (!departmentId) throw new UserInputError("Choose a department.")
      if (input.departmentId !== undefined || input.projectId !== undefined || input.clientId !== undefined || input.clientName !== undefined) {
        const project = await resolveProject(tx, user, {
          departmentId,
          projectId: input.projectId !== undefined ? input.projectId : row.project.billingModel === "INTERNAL" ? null : row.projectId,
          clientId: input.clientId !== undefined ? input.clientId : row.project.clientId,
          clientName: input.clientName ?? null,
        })
        data.projectId = project.id
      }
      if (input.categoryId !== undefined) data.categoryId = (await resolveCategory(tx, user, kind, input.categoryId, departmentId)).id
      if (input.item !== undefined) {
        const item = input.item.trim()
        if (!item || item.length > 200) throw new UserInputError("Enter the item (max 200 characters).")
        data.description = item
      }
      if (input.amount !== undefined || input.currency !== undefined) {
        const amount = input.amount ?? new Decimal(row.amount)
        const currency = input.currency ?? row.currency
        if (amount.lte(0)) throw new UserInputError("Amount must be greater than zero.")
        const fxRate = await fxRateFor(tx, user, currency, m)
        Object.assign(data, { amount: amount.toString(), currency, fxRateToBase: fxRate.toString(), baseAmount: toBase(amount, fxRate).toString() })
      }
      if (input.date !== undefined) data[kind === "income" ? "invoiceDate" : "incurredDate"] = checkDate(input.date, m)
      if (input.teamId !== undefined) {
        if (input.teamId && !(await tx.team.findFirst({ where: { id: input.teamId, department: { organizationId: user.organizationId } } }))) throw new UserInputError("Team not found.")
        data.teamId = input.teamId
      }
    }
    if (kind === "income") await tx.projectIncome.update({ where: { id }, data })
    else await tx.projectCost.update({ where: { id }, data })
    await audit(tx, user, `project_${kind}.update`, `project_${kind}`, id, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : (v as string | null)])))
  })
}

export async function deleteLedgerEntry(user: SessionUser, kind: LedgerKind, id: string, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const row = await loadRow(tx, user, kind, id)
    if (row.journalEntryId) throw new UserInputError("Un-confirm the row before deleting it.")
    if (kind === "income") await tx.projectIncome.delete({ where: { id } })
    else await tx.projectCost.delete({ where: { id } })
    await audit(tx, user, `project_${kind}.delete`, `project_${kind}`, id, { item: row.description, amount: row.amount.toString() })
  })
}

/**
 * Confirm = recognize and post:  income  Dr Accounts receivable  / Cr revenue category account
 *                                cost    Dr expense category account / Cr Accounts payable
 * Un-confirm posts a reversal (only while nothing has been received or paid).
 */
export async function setLedgerConfirmed(user: SessionUser, kind: LedgerKind, id: string, confirmed: boolean, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const row = await loadRow(tx, user, kind, id)
    const m = { year: row.period.year, month: row.period.month }
    assertPeriodOpen(row.period, m, user)
    const settled = kind === "income" ? new Decimal((row as { receivedAmount: Prisma.Decimal }).receivedAmount).gt(0) : row.status === "PAID"
    const dims = { departmentId: row.project.departmentId, projectId: row.projectId, clientId: row.project.clientId, categoryId: row.categoryId }
    const date = kind === "income" ? ((row as { invoiceDate: Date | null }).invoiceDate ?? monthStart(m)) : (row as { incurredDate: Date }).incurredDate

    if (confirmed) {
      if (row.journalEntryId) return
      const amount = new Decimal(row.baseAmount)
      const categoryAccount = row.category.ledgerAccountId ?? (await accountByCode(tx, user.organizationId, kind === "income" ? "4000" : "6900"))
      const counter = await accountByCode(tx, user.organizationId, kind === "income" ? "1200" : "2000")
      const entry = await postJournal(tx, user, {
        periodId: row.periodId,
        entryDate: date,
        description: `${kind === "income" ? "Income" : "Cost"}: ${row.description}`,
        source: kind === "income" ? "PROJECT_INCOME" : "PROJECT_COST",
        lines:
          kind === "income"
            ? [{ accountId: counter, debit: amount, ...dims }, { accountId: categoryAccount, credit: amount, ...dims }]
            : [{ accountId: categoryAccount, debit: amount, ...dims }, { accountId: counter, credit: amount, ...dims }],
      })
      if (kind === "income") await tx.projectIncome.update({ where: { id }, data: { journalEntryId: entry!.id, status: row.status === "PLANNED" ? "INVOICED" : (row.status as "INVOICED") } })
      else await tx.projectCost.update({ where: { id }, data: { journalEntryId: entry!.id, status: row.status === "PLANNED" ? "INCURRED" : (row.status as "INCURRED") } })
      await audit(tx, user, `project_${kind}.confirm`, `project_${kind}`, id, { journalEntryId: entry!.id })
      return
    }

    if (!row.journalEntryId) return
    if (settled) throw new UserInputError("Payments are already recorded for this row; it cannot be un-confirmed.")
    await reverseJournal(tx, user, row.journalEntryId, { periodId: row.periodId, entryDate: date, description: `Reversal: ${row.description}` })
    if (kind === "income") await tx.projectIncome.update({ where: { id }, data: { journalEntryId: null, status: "PLANNED" } })
    else await tx.projectCost.update({ where: { id }, data: { journalEntryId: null, status: "PLANNED" } })
    await audit(tx, user, `project_${kind}.unconfirm`, `project_${kind}`, id)
  })
}

/**
 * Records money received (income, partial allowed) or paid (cost, in full) through a company account:
 *   income  Dr company account / Cr Accounts receivable
 *   cost    Dr Accounts payable / Cr company account
 */
export async function recordSettlement(
  user: SessionUser,
  kind: LedgerKind,
  id: string,
  input: { amount: Decimal | null; financialAccountId: string; date: Date },
  db: Db = prisma,
) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const row = await loadRow(tx, user, kind, id)
    if (!row.journalEntryId) throw new UserInputError("Confirm the row before recording a payment.")
    const account = await tx.financialAccount.findFirst({ where: { id: input.financialAccountId, organizationId: user.organizationId, closedAt: null } })
    if (!account) throw new UserInputError("Choose the company account.")
    const amount = new Decimal(row.amount)
    const fx = new Decimal(row.fxRateToBase)
    let delta: Decimal
    if (kind === "income") {
      const received = new Decimal((row as { receivedAmount: Prisma.Decimal }).receivedAmount)
      delta = input.amount ?? amount.sub(received)
      if (delta.lte(0) || received.add(delta).gt(amount)) throw new UserInputError("The amount is more than what is still to be received.")
    } else {
      if (row.status === "PAID") throw new UserInputError("This cost is already paid.")
      delta = amount
    }
    const base = toBase(delta, fx)
    const month = { year: input.date.getUTCFullYear(), month: input.date.getUTCMonth() + 1 }
    const period = await ensurePeriod(tx, user.organizationId, month)
    assertPeriodOpen(period, month, user)
    const dims = { departmentId: row.project.departmentId, projectId: row.projectId, clientId: row.project.clientId }
    const counter = await accountByCode(tx, user.organizationId, kind === "income" ? "1200" : "2000")
    await postJournal(tx, user, {
      periodId: period.id,
      entryDate: input.date,
      description: `${kind === "income" ? "Received" : "Paid"}: ${row.description}`,
      source: kind === "income" ? "PROJECT_INCOME" : "PROJECT_COST",
      lines:
        kind === "income"
          ? [{ accountId: account.ledgerAccountId, debit: base, ...dims }, { accountId: counter, credit: base, ...dims }]
          : [{ accountId: counter, debit: base, ...dims }, { accountId: account.ledgerAccountId, credit: base, ...dims }],
    })
    if (kind === "income") {
      const received = new Decimal((row as { receivedAmount: Prisma.Decimal }).receivedAmount).add(delta)
      await tx.projectIncome.update({ where: { id }, data: { receivedAmount: received.toString(), receivedDate: input.date, status: received.eq(amount) ? "RECEIVED" : "PARTIALLY_RECEIVED" } })
    } else {
      await tx.projectCost.update({ where: { id }, data: { status: "PAID", paidDate: input.date } })
    }
    await audit(tx, user, `project_${kind}.settle`, `project_${kind}`, id, { amount: delta.toString(), accountId: account.id })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Teams (e.g. "Команда Саня" inside Influence) and monthly carry-over of recurring costs
// ─────────────────────────────────────────────────────────────────────────────

export async function createLedgerTeam(user: SessionUser, departmentId: string, name: string, db: Db = prisma) {
  requireManage(user)
  const clean = name.trim()
  if (!clean || clean.length > 80) throw new UserInputError("Enter a team name (max 80 characters).")
  return inTx(db, async (tx) => {
    const department = await tx.department.findFirst({ where: { id: departmentId, organizationId: user.organizationId, archivedAt: null } })
    if (!department) throw new UserInputError("Choose a department.")
    const clash = await tx.team.findFirst({ where: { departmentId, archivedAt: null, name: { equals: clean, mode: "insensitive" } } })
    if (clash) throw new UserInputError("A team with this name already exists in the department.")
    const code = await uniqueCode(clean, async (c) => Boolean(await tx.team.findUnique({ where: { departmentId_code: { departmentId, code: c } } })))
    const last = await tx.team.aggregate({ where: { departmentId }, _max: { sortOrder: true } })
    const team = await tx.team.create({ data: { departmentId, code, name: clean, sortOrder: (last._max.sortOrder ?? 0) + 10 } })
    await audit(tx, user, "team.create", "team", team.id, { name: clean, departmentId })
    return team
  })
}

export async function updateLedgerTeam(user: SessionUser, teamId: string, input: { name?: string; archived?: boolean; move?: "up" | "down" }, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const team = await tx.team.findFirst({ where: { id: teamId, department: { organizationId: user.organizationId } } })
    if (!team) throw new UserInputError("Team not found.")
    if (input.name !== undefined) {
      const clean = input.name.trim()
      if (!clean || clean.length > 80) throw new UserInputError("Enter a team name (max 80 characters).")
      await tx.team.update({ where: { id: teamId }, data: { name: clean } })
    }
    if (input.archived !== undefined) await tx.team.update({ where: { id: teamId }, data: { archivedAt: input.archived ? new Date() : null } })
    if (input.move) {
      const siblings = await tx.team.findMany({ where: { departmentId: team.departmentId, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
      const i = siblings.findIndex((t) => t.id === teamId)
      const j = input.move === "up" ? i - 1 : i + 1
      if (i >= 0 && j >= 0 && j < siblings.length) {
        const order = siblings.map((t) => t.id)
        ;[order[i], order[j]] = [order[j], order[i]]
        for (const [index, id] of order.entries()) await tx.team.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } })
      }
    }
    await audit(tx, user, "team.update", "team", teamId, input)
  })
}

const previousMonthOf = (m: Month): Month => (m.month === 1 ? { year: m.year - 1, month: 12 } : { year: m.year, month: m.month - 1 })

/**
 * Recurring costs of the immediately previous month that can be carried into this month. Only the
 * structure is offered (item, category, team, planned amount); actual income, profit and cash
 * movements are never copied.
 */
export async function recurringCostPreview(user: SessionUser, m: Month, db: Db = prisma) {
  if (!user.permissions.has("project_finance:read")) throw new UserInputError("You do not have permission to view project finance.")
  const prev = previousMonthOf(m)
  const rows = await db.projectCost.findMany({
    where: { recurring: true, status: { not: "CANCELLED" }, period: { organizationId: user.organizationId, year: prev.year, month: prev.month } },
    include: { project: { include: { department: true, client: true } }, category: true, team: true, carriedTo: { where: { period: { year: m.year, month: m.month } }, select: { id: true } } },
    orderBy: { createdAt: "asc" },
  })
  return {
    previous: `${prev.year}-${String(prev.month).padStart(2, "0")}`,
    rows: rows.map((r) => ({
      id: r.id,
      item: r.description,
      amount: r.amount.toString(),
      currency: r.currency,
      categoryId: r.categoryId,
      categoryName: r.category.name,
      departmentId: r.project.departmentId,
      departmentName: r.project.department?.name ?? null,
      teamId: r.teamId,
      teamName: r.team?.name ?? null,
      clientName: r.project.client?.name ?? null,
      notes: r.notes,
      present: r.carriedTo.length > 0,
    })),
  }
}

export type CarryCostItem = { id: string; item?: string | null; amount?: string | null; categoryId?: string | null; teamId?: string | null; recurring?: boolean; notes?: string | null }

/**
 * Carries selected recurring costs into the month as PLANNED (not yet incurred) rows. They reach the
 * P&L only when confirmed and Cash Flow only when paid. A cost already carried is skipped, never
 * duplicated (unique per month and source). The previous month is never changed.
 */
export async function carryRecurringCosts(user: SessionUser, m: Month, items: CarryCostItem[], db: Db = prisma) {
  requireManage(user)
  if (!Array.isArray(items) || items.length === 0) throw new UserInputError("Choose the costs to carry over.")
  if (items.length > 300) throw new UserInputError("Too many rows at once.")
  const prev = previousMonthOf(m)
  let added = 0
  let skipped = 0
  for (const item of items) {
    await inTx(db, async (tx) => {
      const period = await ensurePeriod(tx, user.organizationId, m)
      assertPeriodOpen(period, m, user)
      const source = await tx.projectCost.findFirst({ where: { id: item.id, recurring: true, project: { organizationId: user.organizationId }, period: { year: prev.year, month: prev.month } }, include: { project: true } })
      if (!source) throw new UserInputError("Only recurring costs of the previous month can be carried over.")
      if (await tx.projectCost.findFirst({ where: { periodId: period.id, carriedFromId: source.id } })) {
        skipped++
        return
      }
      const amount = item.amount ? new Decimal(item.amount.replace(/[\s,]/g, "")) : new Decimal(source.amount)
      if (!amount.isFinite() || amount.lte(0)) throw new UserInputError("Amount must be greater than zero.")
      const category = item.categoryId ? await resolveCategory(tx, user, "cost", item.categoryId, source.project.departmentId!) : null
      if (item.teamId && !(await tx.team.findFirst({ where: { id: item.teamId, department: { organizationId: user.organizationId } } }))) throw new UserInputError("Team not found.")
      const fxRate = await fxRateFor(tx, user, source.currency, m)
      const row = await tx.projectCost.create({
        data: {
          projectId: source.projectId,
          periodId: period.id,
          categoryId: category?.id ?? source.categoryId,
          description: (item.item?.trim() || source.description).slice(0, 200),
          status: "PLANNED",
          amount: amount.toString(),
          currency: source.currency,
          fxRateToBase: fxRate.toString(),
          baseAmount: toBase(amount, fxRate).toString(),
          incurredDate: monthStart(m),
          notes: item.notes !== undefined ? item.notes?.slice(0, 2000) || null : source.notes,
          teamId: item.teamId !== undefined ? item.teamId : source.teamId,
          recurring: item.recurring ?? true,
          carriedFromId: source.id,
        },
      })
      await audit(tx, user, "project_cost.carry_forward", "project_cost", row.id, { from: source.id, month: `${m.year}-${String(m.month).padStart(2, "0")}` })
      added++
    })
  }
  return { added, skipped }
}
