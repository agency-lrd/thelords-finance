import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import { monthOfDate } from "@/lib/period"
import { KINDS, OWNER_KINDS, kindOf, type Kind, type KindSpec } from "@/lib/transactions/kinds"

import { audit, uniqueCode } from "./common"
import { inTx, prisma, type Db } from "./db"
import { recordPayment } from "./sheet"
import { createTransaction, type TransactionInput } from "./transactions"

/*
 * The simple cash register. Every movement is ONE transaction (or, for salaries, ONE payroll payment
 * against an approved payslip), posted once. Transactions, Cash Flow, Owners and client analytics all
 * read those same records, so nothing is entered twice and nothing is counted twice.
 */

export type MovementInput = {
  kind: Kind
  date: Date
  amount: Decimal
  currency: string
  fxRate: Decimal | null
  fee: Decimal | null
  financialAccountId: string | null
  counterFinancialAccountId: string | null
  departmentId: string | null
  /** An existing client, or a new advertiser name (created in the client directory). */
  clientId: string | null
  clientName: string | null
  clientCategoryId: string | null
  projectId: string | null
  teamId: string | null
  shareholderId: string | null
  categoryId: string | null
  counterparty: string | null
  description: string | null
  notes: string | null
}

/** Revenue category by department (falls back to agency revenue). Departments are matched by code. */
const REVENUE_BY_DEPARTMENT: Record<string, string> = {
  INFLULORDS: "INFLUENCER-REVENUE",
  VIRALVERSE: "CLIPPING-REVENUE",
  "AI-PRODUCTION": "AI-REVENUE",
  MARKETING: "MEDIA-BUYING",
}

async function findOrCreateClient(tx: Parameters<Parameters<typeof inTx>[1]>[0], user: SessionUser, input: MovementInput) {
  if (input.clientId) {
    const client = await tx.client.findFirst({ where: { id: input.clientId, organizationId: user.organizationId } })
    if (!client) throw new UserInputError("Client not found.")
    if (input.clientCategoryId && client.categoryId !== input.clientCategoryId) {
      await tx.client.update({ where: { id: client.id }, data: { categoryId: input.clientCategoryId } })
    }
    return client.id
  }
  const name = input.clientName?.trim()
  if (!name) return null
  if (name.length > 160) throw new UserInputError("Advertiser name is too long.")
  const existing = await tx.client.findFirst({ where: { organizationId: user.organizationId, name: { equals: name, mode: "insensitive" } } })
  if (existing) return existing.id
  if (input.clientCategoryId && !(await tx.clientCategory.findFirst({ where: { id: input.clientCategoryId, organizationId: user.organizationId } }))) throw new UserInputError("Client category not found.")
  const code = await uniqueCode(name, async (c) => Boolean(await tx.client.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })))
  const client = await tx.client.create({ data: { organizationId: user.organizationId, code, name, categoryId: input.clientCategoryId, status: "ACTIVE" } })
  await audit(tx, user, "client.create", "client", client.id, { name, via: "cash register" })
  return client.id
}

/**
 * Records one money movement of a given kind as a transaction. Posted at once when the user may post
 * (journal:post), otherwise saved as a draft for approval. Salaries are paid with paySalary instead.
 */
export async function recordMovement(user: SessionUser, input: MovementInput, db: Db = prisma) {
  const spec: KindSpec | undefined = KINDS[input.kind]
  if (!spec) throw new UserInputError("Choose the type of movement.")
  const type = spec?.type
  if (!type) throw new UserInputError("Salaries are paid against an approved payslip: choose the employee and month.")
  if (spec.needs.shareholder && !input.shareholderId) throw new UserInputError("Choose the owner or investor.")
  if (spec.needs.counterAccount && !input.counterFinancialAccountId) throw new UserInputError("Choose the destination account.")
  const post = user.permissions.has("journal:post")
  return inTx(db, async (tx) => {
    const org = user.organizationId
    const clientId = await findOrCreateClient(tx, user, input)
    if (spec.needs.client && input.kind !== "REFUND_OUT" && !clientId) throw new UserInputError("Enter the advertiser (client).")

    let categoryId = input.categoryId
    if (!categoryId) {
      let code: string | undefined = spec.categoryCode
      if (input.kind === "CLIENT_PAYMENT") {
        const department = input.departmentId ? await tx.department.findFirst({ where: { id: input.departmentId, organizationId: org } }) : null
        code = (department && REVENUE_BY_DEPARTMENT[department.code]) || "AGENCY-REVENUE"
      }
      if (code) categoryId = (await tx.financialCategory.findFirst({ where: { organizationId: org, code, archivedAt: null } }))?.id ?? null
    }
    if (spec.needs.category && !categoryId) throw new UserInputError("Choose a category.")
    const accountCode = async (code: string | undefined) => (code ? (await tx.ledgerAccount.findFirst({ where: { organizationId: org, code } }))?.id ?? null : null)

    const counterparty = input.counterparty?.trim() || null
    const description = input.description?.trim() || [counterparty ?? input.clientName?.trim() ?? null, input.kind.replaceAll("_", " ").toLowerCase()].filter(Boolean).join(" · ")
    const t: TransactionInput = {
      type,
      date: input.date,
      description: description.slice(0, 300),
      amount: input.amount,
      currency: input.currency,
      fxRate: input.fxRate,
      fee: input.fee,
      financialAccountId: input.financialAccountId,
      counterFinancialAccountId: input.counterFinancialAccountId,
      categoryId: type === "REVENUE" || type === "OPERATING_EXPENSE" || type === "REFUND" ? categoryId : null,
      debitAccountId: await accountCode(spec.debitCode),
      creditAccountId: await accountCode(spec.creditCode),
      departmentId: input.departmentId,
      clientId,
      projectId: input.projectId,
      shareholderId: input.shareholderId,
      counterparty,
      direction: spec.refund ?? null,
      settlementStatus: "PAID",
      dueDate: null,
      notes: input.notes,
      attachmentUrl: null,
      kind: input.kind,
      teamId: input.teamId,
    }
    const created = await createTransaction(user, t, { post }, tx)
    return { id: created.id, number: created.number, posted: post }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Salaries: paid against approved payslips (one payment record, never a second expense)
// ─────────────────────────────────────────────────────────────────────────────

/** Approved payslips with money still to pay, for the salary payment form. */
export async function payslipsToPay(user: SessionUser, db: Db = prisma) {
  if (!user.permissions.has("payroll:read")) return []
  const items = await db.payrollItem.findMany({
    where: { payrollRun: { organizationId: user.organizationId, status: { in: ["APPROVED", "PAYING"] } } },
    include: {
      employee: { select: { firstName: true, lastName: true } },
      payrollRun: { include: { period: { select: { year: true, month: true } } } },
      payments: { where: { status: { in: ["SENT", "CONFIRMED"] } }, select: { baseAmount: true } },
    },
    orderBy: [{ payrollRun: { period: { startDate: "desc" } } }],
  })
  return items
    .map((i) => {
      const fx = new Decimal(i.fxRateToBase)
      const paid = i.payments.reduce((a, p) => a.add(new Decimal(p.baseAmount)), new Decimal(0)).div(fx).toDecimalPlaces(2)
      const outstanding = new Decimal(i.netAmount).sub(paid)
      const p = i.payrollRun.period
      return {
        payrollItemId: i.id,
        employeeId: i.employeeId,
        name: [i.employee.firstName, i.employee.lastName].filter(Boolean).join(" "),
        month: `${p.year}-${String(p.month).padStart(2, "0")}`,
        approved: new Decimal(i.netAmount).toString(),
        paid: paid.toString(),
        outstanding: outstanding.toString(),
        currency: i.currency,
      }
    })
    .filter((i) => new Decimal(i.outstanding).gt("0.009"))
}

/** Pays (part of) an approved payslip: one payroll payment, posted once (Dr payroll payable, Cr cash). */
export async function paySalary(
  user: SessionUser,
  input: { payrollItemId: string; amount: Decimal; currency: string; fxRate: Decimal | null; fee: Decimal | null; financialAccountId: string; paidAt: Date; reference: string | null },
  db: Db = prisma,
) {
  const item = await db.payrollItem.findFirst({ where: { id: input.payrollItemId, payrollRun: { organizationId: user.organizationId } }, include: { payrollRun: { include: { period: true } } } })
  if (!item) throw new UserInputError("Choose an approved payslip.")
  const m = { year: item.payrollRun.period.year, month: item.payrollRun.period.month }
  return recordPayment(user, m, { employeeId: item.employeeId, amount: input.amount, currency: input.currency, fxRate: input.fxRate, fee: input.fee, financialAccountId: input.financialAccountId, paidAt: input.paidAt, reference: input.reference }, db)
}

/** Salary payments as register rows (read-only here; the record lives on the payslip). */
export async function listSalaryPayments(user: SessionUser, filters: { from?: Date | null; to?: Date | null; financialAccountId?: string | null } = {}, db: Db = prisma) {
  if (!user.permissions.has("payroll:read") || !user.permissions.has("ledger:read")) return []
  const payments = await db.payrollPayment.findMany({
    where: {
      payrollItem: { payrollRun: { organizationId: user.organizationId } },
      status: { in: ["SENT", "CONFIRMED", "REVERSED"] },
      ...(filters.from || filters.to ? { paidAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: new Date(filters.to.getTime() + 86_399_999) } : {}) } } : {}),
      ...(filters.financialAccountId ? { financialAccountId: filters.financialAccountId } : {}),
    },
    include: {
      financialAccount: { select: { name: true } },
      payrollItem: { include: { employee: { select: { firstName: true, lastName: true } }, department: { select: { name: true } }, payrollRun: { include: { period: { select: { year: true, month: true } } } } } },
      journalEntry: { select: { entryNumber: true } },
    },
    orderBy: { paidAt: "desc" },
    take: 1000,
  })
  return payments.map((p) => {
    const period = p.payrollItem.payrollRun.period
    return {
      id: p.id,
      date: (p.paidAt ?? p.createdAt).toISOString().slice(0, 10),
      employee: [p.payrollItem.employee.firstName, p.payrollItem.employee.lastName].filter(Boolean).join(" "),
      payrollMonth: `${period.year}-${String(period.month).padStart(2, "0")}`,
      amount: p.amount.toString(),
      currency: p.currency,
      baseAmount: p.baseAmount.toString(),
      account: p.financialAccount?.name ?? null,
      department: p.payrollItem.department?.name ?? null,
      status: p.status,
      reference: p.externalReference,
      journalEntryNumber: p.journalEntry?.entryNumber ?? null,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Owners and investors: the same transactions, filtered
// ─────────────────────────────────────────────────────────────────────────────

export async function ownerMovements(user: SessionUser, db: Db = prisma) {
  if (!user.permissions.has("ledger:read") && !user.permissions.has("ownership:read")) return []
  const rows = await db.transaction.findMany({
    where: { organizationId: user.organizationId, OR: [{ shareholderId: { not: null } }, { kind: { in: OWNER_KINDS } }, { type: { in: ["OWNER_CONTRIBUTION", "OWNER_WITHDRAWAL"] } }] },
    include: { shareholder: { select: { name: true } }, financialAccount: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { number: "desc" }],
    take: 500,
  })
  return rows.map((t) => ({
    id: t.id,
    number: t.number,
    date: t.date.toISOString().slice(0, 10),
    kind: kindOf(t),
    shareholderId: t.shareholderId,
    shareholder: t.shareholder?.name ?? null,
    amount: t.amount.toString(),
    currency: t.currency,
    baseAmount: t.baseAmount.toString(),
    account: t.financialAccount?.name ?? null,
    status: t.status,
    notes: t.notes,
    description: t.description,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Client categories
// ─────────────────────────────────────────────────────────────────────────────

function requireClients(user: SessionUser) {
  if (!user.permissions.has("journal:create") && !user.permissions.has("structure:manage")) throw new UserInputError("You do not have permission to manage client categories.")
}

export async function listClientCategories(user: SessionUser, db: Db = prisma) {
  return db.clientCategory.findMany({ where: { organizationId: user.organizationId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
}

export async function saveClientCategory(user: SessionUser, input: { id: string | null; name: string }, db: Db = prisma) {
  requireClients(user)
  const name = input.name.trim()
  if (!name || name.length > 80) throw new UserInputError("Enter a category name (max 80 characters).")
  return inTx(db, async (tx) => {
    const clash = await tx.clientCategory.findFirst({ where: { organizationId: user.organizationId, name: { equals: name, mode: "insensitive" }, ...(input.id ? { id: { not: input.id } } : {}) } })
    if (clash) throw new UserInputError("A client category with this name already exists.")
    if (input.id) {
      const { count } = await tx.clientCategory.updateMany({ where: { id: input.id, organizationId: user.organizationId }, data: { name } })
      if (!count) throw new UserInputError("Category not found.")
      await audit(tx, user, "client_category.rename", "client_category", input.id, { name })
      return input.id
    }
    const last = await tx.clientCategory.aggregate({ where: { organizationId: user.organizationId }, _max: { sortOrder: true } })
    const created = await tx.clientCategory.create({ data: { organizationId: user.organizationId, name, sortOrder: (last._max.sortOrder ?? 0) + 10 } })
    await audit(tx, user, "client_category.create", "client_category", created.id, { name })
    return created.id
  })
}

export async function setClientCategoryArchived(user: SessionUser, id: string, archived: boolean, db: Db = prisma) {
  requireClients(user)
  return inTx(db, async (tx) => {
    const { count } = await tx.clientCategory.updateMany({ where: { id, organizationId: user.organizationId }, data: { archivedAt: archived ? new Date() : null } })
    if (!count) throw new UserInputError("Category not found.")
    await audit(tx, user, archived ? "client_category.archive" : "client_category.restore", "client_category", id)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Client reporting: cash received vs revenue recognized
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advertisers for a date range. Cash received = posted client payments and client budgets received
 * (pass-through budgets are cash, not revenue). Revenue recognized = revenue lines in the ledger for
 * the client (transactions and confirmed project income). The two are shown side by side, never mixed.
 */
export async function clientReport(user: SessionUser, from: Date, to: Date, db: Db = prisma) {
  if (!user.permissions.has("reports:read")) throw new UserInputError("You do not have permission to view reports.")
  const org = user.organizationId
  const receipts = await db.transaction.findMany({
    where: { organizationId: org, status: "POSTED", date: { gte: from, lte: to }, clientId: { not: null }, type: { in: ["REVENUE", "LOAN_RECEIVED"] } },
    select: { clientId: true, kind: true, type: true, baseAmount: true, date: true, departmentId: true, projectId: true, direction: true, shareholderId: true },
  })
  const revenue = await db.journalLine.findMany({
    where: {
      clientId: { not: null },
      ledgerAccount: { organizationId: org, type: "REVENUE" },
      journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { gte: from, lte: to } },
    },
    select: { clientId: true, debit: true, credit: true, departmentId: true, projectId: true, journalEntry: { select: { entryDate: true } } },
  })
  const clients = await db.client.findMany({ where: { organizationId: org }, include: { category: { select: { name: true } } } })
  const departments = new Map((await db.department.findMany({ where: { organizationId: org }, select: { id: true, name: true } })).map((d) => [d.id, d.name]))
  const projects = new Map((await db.project.findMany({ where: { organizationId: org }, select: { id: true, name: true } })).map((p) => [p.id, p.name]))

  type Totals = { cash: Decimal; budgets: Decimal; revenue: Decimal }
  const zero = (): Totals => ({ cash: new Decimal(0), budgets: new Decimal(0), revenue: new Decimal(0) })
  const add = (map: Map<string, Totals>, key: string, field: keyof Totals, value: Decimal) => {
    const row = map.get(key) ?? zero()
    row[field] = row[field].add(value)
    map.set(key, row)
  }
  const byClient = new Map<string, Totals>()
  const byMonth = new Map<string, Totals>()
  const byDepartment = new Map<string, Totals>()
  const byProject = new Map<string, Totals>()
  const byCategory = new Map<string, Totals>()
  const categoryOf = new Map(clients.map((c) => [c.id, c.category?.name ?? "—"]))
  for (const r of receipts) {
    const kind = kindOf({ ...r, shareholderId: r.shareholderId })
    const field: keyof Totals = kind === "CLIENT_BUDGET" ? "budgets" : "cash"
    const v = new Decimal(r.baseAmount)
    const m = monthOfDate(r.date)
    add(byClient, r.clientId!, field, v)
    add(byMonth, `${m.year}-${String(m.month).padStart(2, "0")}`, field, v)
    add(byDepartment, r.departmentId ?? "", field, v)
    add(byProject, r.projectId ?? "", field, v)
    add(byCategory, categoryOf.get(r.clientId!) ?? "—", field, v)
  }
  for (const l of revenue) {
    const v = new Decimal(l.credit).sub(l.debit)
    const m = monthOfDate(l.journalEntry.entryDate)
    add(byClient, l.clientId!, "revenue", v)
    add(byMonth, `${m.year}-${String(m.month).padStart(2, "0")}`, "revenue", v)
    add(byDepartment, l.departmentId ?? "", "revenue", v)
    add(byProject, l.projectId ?? "", "revenue", v)
    add(byCategory, categoryOf.get(l.clientId!) ?? "—", "revenue", v)
  }
  const out = (map: Map<string, Totals>, name: (key: string) => string) =>
    [...map.entries()].map(([key, t]) => ({ key, name: name(key), cash: t.cash.toString(), budgets: t.budgets.toString(), revenue: t.revenue.toString() }))
  const clientName = new Map(clients.map((c) => [c.id, c.name]))
  return {
    clients: out(byClient, (k) => clientName.get(k) ?? "—").map((r) => ({ ...r, category: categoryOf.get(r.key) ?? "—" })),
    months: out(byMonth, (k) => k).sort((a, b) => a.key.localeCompare(b.key)),
    departments: out(byDepartment, (k) => departments.get(k) ?? "—"),
    projects: out(byProject, (k) => projects.get(k) ?? "—"),
    categories: out(byCategory, (k) => k),
  }
}
