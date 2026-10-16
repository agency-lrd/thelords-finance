import "server-only"

import { createHash } from "node:crypto"

import type { Prisma, SettlementStatus, TransactionType } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal, toBase } from "@/lib/money"
import { monthOfDate } from "@/lib/period"

import { assertPeriodOpen, audit, ensurePeriod, fxRateFor, type Tx } from "./common"
import { inTx, prisma, type Db } from "./db"
import { accountByCode, postJournal, reverseJournal, type JournalLineInput } from "./ledger"

/*
 * Manual transactions. Each type posts through a fixed double-entry template, so money movements that
 * are not income (internal transfers, owner contributions, loans, investments) can never reach revenue:
 *
 *   REVENUE            Dr cash (paid) or receivables (unpaid)   Cr revenue category
 *   OPERATING_EXPENSE  Dr expense category                       Cr cash (paid) or payables (unpaid)
 *   PAYROLL            Dr payroll payable (or payroll category)  Cr cash
 *   INTERNAL_TRANSFER  Dr to-account, Dr fees                     Cr from-account
 *   OWNER_CONTRIBUTION Dr cash                                    Cr owner capital
 *   OWNER_WITHDRAWAL   Dr owner distributions                     Cr cash
 *   LOAN_RECEIVED      Dr cash                                    Cr loan (short-term by default)
 *   LOAN_REPAYMENT     Dr loan                                    Cr cash
 *   INVESTMENT         Dr investments                             Cr cash
 *   TAX_PAYMENT        Dr income tax (or tax payable)             Cr cash
 *   ASSET_PURCHASE     Dr equipment (or chosen asset)             Cr cash (paid) or payables (unpaid)
 *   REFUND OUT         Dr revenue category (refund to a client)   Cr cash
 *   REFUND IN          Dr cash                                    Cr expense category (refund to us)
 *   ADJUSTMENT         Dr chosen account                          Cr chosen account
 * A fee on a cash payment adds Dr bank fees / Cr cash.
 */

export const TRANSACTION_TYPES = [
  "REVENUE",
  "OPERATING_EXPENSE",
  "PAYROLL",
  "INTERNAL_TRANSFER",
  "OWNER_CONTRIBUTION",
  "OWNER_WITHDRAWAL",
  "LOAN_RECEIVED",
  "LOAN_REPAYMENT",
  "INVESTMENT",
  "TAX_PAYMENT",
  "ASSET_PURCHASE",
  "REFUND",
  "ADJUSTMENT",
] as const satisfies readonly TransactionType[]

/** Types that can be booked as unpaid (receivable/payable) and settled later. */
export const SETTLEABLE: TransactionType[] = ["REVENUE", "OPERATING_EXPENSE", "ASSET_PURCHASE"]

const REVENUE_KINDS = ["REVENUE", "OTHER_INCOME"]
const EXPENSE_KINDS = ["COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_EXPENSE", "DEPRECIATION", "AMORTIZATION", "INTEREST"]

export type TransactionInput = {
  type: TransactionType
  date: Date
  description: string
  amount: Decimal
  currency: string
  fxRate: Decimal | null
  fee: Decimal | null
  financialAccountId: string | null
  counterFinancialAccountId: string | null
  categoryId: string | null
  debitAccountId: string | null
  creditAccountId: string | null
  departmentId: string | null
  clientId: string | null
  projectId: string | null
  shareholderId: string | null
  counterparty: string | null
  direction: "IN" | "OUT" | null
  settlementStatus: SettlementStatus
  dueDate: Date | null
  notes: string | null
  attachmentUrl: string | null
  externalRef?: string | null
}

function need(user: SessionUser, permission: "journal:create" | "journal:post") {
  if (!user.permissions.has(permission)) {
    throw new UserInputError(permission === "journal:post" ? "Posting requires the journal:post permission (CFO, Owner or Finance Manager)." : "You do not have permission to enter transactions.")
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation shared by create, update and post
// ─────────────────────────────────────────────────────────────────────────────

async function validate(tx: Tx, user: SessionUser, input: TransactionInput) {
  const org = user.organizationId
  if (!TRANSACTION_TYPES.includes(input.type)) throw new UserInputError("Choose a transaction type.")
  const description = input.description.trim()
  if (!description || description.length > 300) throw new UserInputError("Enter a description (max 300 characters).")
  if (input.amount.lte(0)) throw new UserInputError("Amount must be greater than zero.")
  if (!["USD", "EUR", "GBP", "USDT"].includes(input.currency)) throw new UserInputError("Choose a supported currency.")
  if (input.fee && input.fee.lt(0)) throw new UserInputError("Fee cannot be negative.")
  if (input.attachmentUrl && !/^https:\/\/\S+$/.test(input.attachmentUrl)) throw new UserInputError("Attachment must be an https:// link.")

  const check = async <T>(id: string | null, find: (id: string) => Promise<T | null>, label: string) => {
    if (!id) return null
    const row = await find(id)
    if (!row) throw new UserInputError(`${label} not found.`)
    return row
  }
  const account = await check(input.financialAccountId, (id) => tx.financialAccount.findFirst({ where: { id, organizationId: org } }), "Account")
  const counter = await check(input.counterFinancialAccountId, (id) => tx.financialAccount.findFirst({ where: { id, organizationId: org } }), "Destination account")
  const category = await check(input.categoryId, (id) => tx.financialCategory.findFirst({ where: { id, organizationId: org, archivedAt: null } }), "Category")
  await check(input.debitAccountId, (id) => tx.ledgerAccount.findFirst({ where: { id, organizationId: org, isPostable: true, archivedAt: null } }), "Debit account")
  await check(input.creditAccountId, (id) => tx.ledgerAccount.findFirst({ where: { id, organizationId: org, isPostable: true, archivedAt: null } }), "Credit account")
  await check(input.departmentId, (id) => tx.department.findFirst({ where: { id, organizationId: org } }), "Department")
  await check(input.clientId, (id) => tx.client.findFirst({ where: { id, organizationId: org } }), "Client")
  await check(input.projectId, (id) => tx.project.findFirst({ where: { id, organizationId: org } }), "Project")
  await check(input.shareholderId, (id) => tx.shareholder.findFirst({ where: { id, organizationId: org } }), "Owner")

  const unpaid = input.settlementStatus !== "PAID"
  if (unpaid && !SETTLEABLE.includes(input.type)) throw new UserInputError("Only revenue, expenses and asset purchases can be booked as unpaid.")
  const needsAccount = !(unpaid || input.type === "ADJUSTMENT")
  if (needsAccount && !account) throw new UserInputError("Choose the company account the money moved through.")

  switch (input.type) {
    case "REVENUE":
      if (!category || !REVENUE_KINDS.includes(category.kind)) throw new UserInputError("Choose a revenue category.")
      break
    case "OPERATING_EXPENSE":
      if (!category || !EXPENSE_KINDS.includes(category.kind)) throw new UserInputError("Choose an expense category.")
      if (["DELIVERY-PAYROLL", "OVERHEAD-PAYROLL"].includes(category.code)) throw new UserInputError("Salaries come from the financial sheet. Use type Payroll for payments outside the sheet.")
      break
    case "REFUND":
      if (input.direction !== "IN" && input.direction !== "OUT") throw new UserInputError("Choose the refund direction.")
      if (!category) throw new UserInputError("Choose the category being refunded.")
      if (input.direction === "OUT" && !REVENUE_KINDS.includes(category.kind)) throw new UserInputError("A refund to a client reduces a revenue category.")
      if (input.direction === "IN" && !EXPENSE_KINDS.includes(category.kind)) throw new UserInputError("A refund to us reduces an expense category.")
      break
    case "INTERNAL_TRANSFER":
      if (!counter) throw new UserInputError("Choose the destination account.")
      if (counter.id === account?.id) throw new UserInputError("Choose two different accounts.")
      break
    case "ADJUSTMENT":
      if (!input.debitAccountId || !input.creditAccountId) throw new UserInputError("Choose the debit and credit accounts.")
      if (input.debitAccountId === input.creditAccountId) throw new UserInputError("Debit and credit accounts must differ.")
      break
    case "OWNER_CONTRIBUTION":
    case "OWNER_WITHDRAWAL":
      if (!input.shareholderId) throw new UserInputError("Choose the owner.")
      break
  }
  return { account, counter, category, description }
}

async function amounts(tx: Tx, user: SessionUser, input: TransactionInput) {
  const fx = await fxRateFor(tx, user, input.currency, monthOfDate(input.date), input.fxRate)
  return { fx, base: toBase(input.amount, fx), feeBase: toBase(input.fee ?? new Decimal(0), fx) }
}

function dataOf(input: TransactionInput, description: string, fx: Decimal, base: Decimal) {
  return {
    type: input.type,
    date: input.date,
    description,
    amount: input.amount.toString(),
    currency: input.currency,
    fxRateToBase: fx.toString(),
    baseAmount: base.toString(),
    feeAmount: (input.fee ?? new Decimal(0)).toString(),
    financialAccountId: input.financialAccountId,
    counterFinancialAccountId: input.type === "INTERNAL_TRANSFER" ? input.counterFinancialAccountId : null,
    categoryId: input.categoryId,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
    departmentId: input.departmentId,
    clientId: input.clientId,
    projectId: input.projectId,
    shareholderId: input.shareholderId,
    counterparty: input.counterparty?.slice(0, 200) || null,
    direction: input.type === "REFUND" ? input.direction : null,
    settlementStatus: input.settlementStatus,
    dueDate: input.dueDate,
    notes: input.notes?.slice(0, 2000) || null,
    attachmentUrl: input.attachmentUrl,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create, edit, delete drafts
// ─────────────────────────────────────────────────────────────────────────────

export async function createTransaction(user: SessionUser, input: TransactionInput, options: { post?: boolean } = {}, db: Db = prisma) {
  need(user, "journal:create")
  if (options.post) need(user, "journal:post")
  return inTx(db, async (tx) => {
    const { description } = await validate(tx, user, input)
    const m = monthOfDate(input.date)
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m)
    const { fx, base } = await amounts(tx, user, input)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`transaction_number:${user.organizationId}`}, 0))`
    const last = await tx.transaction.aggregate({ where: { organizationId: user.organizationId }, _max: { number: true } })
    const created = await tx.transaction.create({
      data: {
        ...dataOf(input, description, fx, base),
        organizationId: user.organizationId,
        number: (last._max.number ?? 0) + 1,
        periodId: period.id,
        externalRef: input.externalRef ?? null,
        createdById: user.id,
      },
    })
    await audit(tx, user, "transaction.create", "transaction", created.id, { number: created.number, type: input.type, amount: input.amount.toString(), currency: input.currency })
    if (options.post) await postInTx(tx, user, created.id)
    return created
  })
}

export async function updateDraft(user: SessionUser, id: string, input: TransactionInput, db: Db = prisma) {
  need(user, "journal:create")
  return inTx(db, async (tx) => {
    const current = await tx.transaction.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!current) throw new UserInputError("Transaction not found.")
    if (current.status !== "DRAFT") throw new UserInputError("Only drafts can be edited. Reverse a posted transaction instead.")
    const { description } = await validate(tx, user, input)
    const m = monthOfDate(input.date)
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m)
    const { fx, base } = await amounts(tx, user, input)
    await tx.transaction.update({ where: { id }, data: { ...dataOf(input, description, fx, base), periodId: period.id } })
    await audit(tx, user, "transaction.update", "transaction", id, { number: current.number })
  })
}

export async function deleteDraft(user: SessionUser, id: string, db: Db = prisma) {
  need(user, "journal:create")
  return inTx(db, async (tx) => {
    const current = await tx.transaction.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!current) throw new UserInputError("Transaction not found.")
    if (current.status !== "DRAFT") throw new UserInputError("Posted transactions are reversed, not deleted.")
    await tx.transaction.delete({ where: { id } })
    await audit(tx, user, "transaction.delete", "transaction", id, { number: current.number })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting, reversal, settlement
// ─────────────────────────────────────────────────────────────────────────────

/** The journal lines for a transaction (the double-entry templates described at the top). */
async function journalLines(tx: Tx, user: SessionUser, t: Prisma.TransactionGetPayload<{ include: { financialAccount: true; counterFinancialAccount: true; category: true } }>): Promise<JournalLineInput[]> {
  const org = user.organizationId
  const B = new Decimal(t.baseAmount)
  const F = toBase(new Decimal(t.feeAmount), new Decimal(t.fxRateToBase))
  const dims = { departmentId: t.departmentId, clientId: t.clientId, projectId: t.projectId, categoryId: t.categoryId }
  const cash = t.financialAccount?.ledgerAccountId ?? null
  const categoryAccount = async () => t.category?.ledgerAccountId ?? (await accountByCode(tx, org, REVENUE_KINDS.includes(t.category?.kind ?? "") ? "4090" : "6900"))
  const unpaid = t.settlementStatus !== "PAID"
  const cashOrOpen = async (side: "receivable" | "payable") => (unpaid ? await accountByCode(tx, org, side === "receivable" ? "1200" : "2000") : cash!)
  const feeLines = async (): Promise<JournalLineInput[]> =>
    F.isZero() || !cash ? [] : [{ accountId: await accountByCode(tx, org, "6400"), debit: F, description: "Fee", departmentId: t.departmentId }, { accountId: cash, credit: F }]

  switch (t.type) {
    case "REVENUE":
      return [{ accountId: await cashOrOpen("receivable"), debit: B, ...dims }, { accountId: await categoryAccount(), credit: B, ...dims }, ...(await feeLines())]
    case "OPERATING_EXPENSE":
      return [{ accountId: await categoryAccount(), debit: B, ...dims }, { accountId: await cashOrOpen("payable"), credit: B, ...dims }, ...(await feeLines())]
    case "PAYROLL": {
      const debit = t.category?.ledgerAccountId ?? (await accountByCode(tx, org, "2100"))
      return [{ accountId: debit, debit: B, ...dims }, { accountId: cash!, credit: B }, ...(await feeLines())]
    }
    case "INTERNAL_TRANSFER":
      return [{ accountId: t.counterFinancialAccount!.ledgerAccountId, debit: B }, { accountId: cash!, credit: B }, ...(await feeLines())]
    case "OWNER_CONTRIBUTION":
      return [{ accountId: cash!, debit: B }, { accountId: await accountByCode(tx, org, "3000"), credit: B }, ...(await feeLines())]
    case "OWNER_WITHDRAWAL":
      return [{ accountId: await accountByCode(tx, org, "3200"), debit: B }, { accountId: cash!, credit: B }, ...(await feeLines())]
    case "LOAN_RECEIVED":
      return [{ accountId: cash!, debit: B }, { accountId: t.creditAccountId ?? (await accountByCode(tx, org, "2650")), credit: B }, ...(await feeLines())]
    case "LOAN_REPAYMENT":
      return [{ accountId: t.debitAccountId ?? (await accountByCode(tx, org, "2650")), debit: B }, { accountId: cash!, credit: B }, ...(await feeLines())]
    case "INVESTMENT":
      return [{ accountId: t.debitAccountId ?? (await accountByCode(tx, org, "1600")), debit: B, ...dims }, { accountId: cash!, credit: B }, ...(await feeLines())]
    case "TAX_PAYMENT":
      return [{ accountId: t.category?.ledgerAccountId ?? t.debitAccountId ?? (await accountByCode(tx, org, "9000")), debit: B, ...dims }, { accountId: cash!, credit: B }, ...(await feeLines())]
    case "ASSET_PURCHASE":
      return [{ accountId: t.debitAccountId ?? (await accountByCode(tx, org, "1500")), debit: B, ...dims }, { accountId: await cashOrOpen("payable"), credit: B }, ...(await feeLines())]
    case "REFUND":
      return t.direction === "OUT"
        ? [{ accountId: await categoryAccount(), debit: B, ...dims }, { accountId: cash!, credit: B }, ...(await feeLines())]
        : [{ accountId: cash!, debit: B }, { accountId: await categoryAccount(), credit: B, ...dims }, ...(await feeLines())]
    case "ADJUSTMENT":
      return [{ accountId: t.debitAccountId!, debit: B, ...dims }, { accountId: t.creditAccountId!, credit: B, ...dims }]
  }
}

async function postInTx(tx: Tx, user: SessionUser, id: string) {
  const t = await tx.transaction.findFirst({ where: { id, organizationId: user.organizationId }, include: { financialAccount: true, counterFinancialAccount: true, category: true } })
  if (!t) throw new UserInputError("Transaction not found.")
  if (t.status !== "DRAFT") throw new UserInputError(`Transaction #${t.number} is already ${t.status.toLowerCase()}.`)
  const entry = await postJournal(tx, user, {
    periodId: t.periodId,
    entryDate: t.date,
    description: `#${t.number} ${t.description}`,
    source: "MANUAL",
    lines: await journalLines(tx, user, t),
  })
  if (!entry) throw new UserInputError("Nothing to post.")
  await tx.transaction.update({
    where: { id },
    data: { status: "POSTED", journalEntryId: entry.id, postedById: user.id, postedAt: new Date(), settledAmount: t.settlementStatus === "PAID" ? t.amount : "0" },
  })
  await audit(tx, user, "transaction.post", "transaction", id, { number: t.number, journalEntryId: entry.id })
}

export async function postTransactions(user: SessionUser, ids: string[], db: Db = prisma) {
  need(user, "journal:post")
  return inTx(db, async (tx) => {
    for (const id of ids) await postInTx(tx, user, id)
    return ids.length
  })
}

export async function reverseTransaction(user: SessionUser, id: string, reason: string, db: Db = prisma) {
  need(user, "journal:post")
  return inTx(db, async (tx) => {
    const t = await tx.transaction.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!t || t.status !== "POSTED" || !t.journalEntryId) throw new UserInputError("Only posted transactions can be reversed.")
    if (t.settlementStatus !== "PAID" && new Decimal(t.settledAmount).gt(0)) throw new UserInputError("Payments were recorded against this transaction; reverse those first.")
    // The reversal is dated in the original period when it is open, otherwise today.
    const original = await tx.financialPeriod.findUniqueOrThrow({ where: { id: t.periodId } })
    const open = original.status === "OPEN" || original.status === "CLOSING"
    const date = open ? t.date : new Date(new Date().toISOString().slice(0, 10))
    const period = open ? original : await ensurePeriod(tx, user.organizationId, monthOfDate(date))
    await reverseJournal(tx, user, t.journalEntryId, { periodId: period.id, entryDate: date, description: `Reversal of #${t.number}${reason ? `: ${reason}` : ""}` })
    await tx.transaction.update({ where: { id }, data: { status: "REVERSED" } })
    await audit(tx, user, "transaction.reverse", "transaction", id, { number: t.number, reason })
  })
}

/** Records a (partial) payment of an unpaid revenue/expense: Dr cash / Cr receivables, or Dr payables / Cr cash. */
export async function settleTransaction(user: SessionUser, id: string, input: { amount: Decimal | null; financialAccountId: string; date: Date }, db: Db = prisma) {
  need(user, "journal:post")
  return inTx(db, async (tx) => {
    const t = await tx.transaction.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!t || t.status !== "POSTED") throw new UserInputError("Only posted transactions can be settled.")
    if (t.settlementStatus === "PAID") throw new UserInputError("This transaction is already paid.")
    const account = await tx.financialAccount.findFirst({ where: { id: input.financialAccountId, organizationId: user.organizationId } })
    if (!account) throw new UserInputError("Choose the company account.")
    const remaining = new Decimal(t.amount).sub(t.settledAmount)
    const amount = input.amount ?? remaining
    if (amount.lte(0) || amount.gt(remaining)) throw new UserInputError("The amount is more than what is still open.")
    const base = toBase(amount, new Decimal(t.fxRateToBase))
    const m = monthOfDate(input.date)
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m)
    const receivable = t.type === "REVENUE"
    const open = await accountByCode(tx, user.organizationId, receivable ? "1200" : "2000")
    const dims = { departmentId: t.departmentId, clientId: t.clientId, projectId: t.projectId }
    await postJournal(tx, user, {
      periodId: period.id,
      entryDate: input.date,
      description: `#${t.number} ${receivable ? "received" : "paid"}: ${t.description}`,
      source: "MANUAL",
      lines: receivable
        ? [{ accountId: account.ledgerAccountId, debit: base, ...dims }, { accountId: open, credit: base, ...dims }]
        : [{ accountId: open, debit: base, ...dims }, { accountId: account.ledgerAccountId, credit: base, ...dims }],
    })
    const settled = new Decimal(t.settledAmount).add(amount)
    await tx.transaction.update({ where: { id }, data: { settledAmount: settled.toString(), settlementStatus: settled.eq(t.amount) ? "PAID" : "PARTIAL" } })
    await audit(tx, user, "transaction.settle", "transaction", id, { number: t.number, amount: amount.toString() })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

export type TransactionFilters = {
  from?: Date | null
  to?: Date | null
  type?: TransactionType | null
  status?: "DRAFT" | "POSTED" | "REVERSED" | null
  financialAccountId?: string | null
  departmentId?: string | null
  categoryId?: string | null
  search?: string | null
}

export async function listTransactions(user: SessionUser, filters: TransactionFilters = {}, db: Db = prisma) {
  if (!user.permissions.has("ledger:read")) throw new UserInputError("You do not have permission to view transactions.")
  const search = filters.search?.trim()
  const rows = await db.transaction.findMany({
    where: {
      organizationId: user.organizationId,
      ...(filters.from || filters.to ? { date: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.financialAccountId ? { OR: [{ financialAccountId: filters.financialAccountId }, { counterFinancialAccountId: filters.financialAccountId }] } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(search
        ? { OR: [{ description: { contains: search, mode: "insensitive" } }, { counterparty: { contains: search, mode: "insensitive" } }, { notes: { contains: search, mode: "insensitive" } }, ...(/^\d+$/.test(search) ? [{ number: Number(search) }] : [])] }
        : {}),
    },
    include: {
      financialAccount: { select: { name: true } },
      counterFinancialAccount: { select: { name: true } },
      category: { select: { name: true, parent: { select: { name: true } } } },
      department: { select: { name: true } },
      client: { select: { name: true } },
      project: { select: { name: true } },
      shareholder: { select: { name: true } },
      period: { select: { year: true, month: true, status: true } },
      journalEntry: { select: { entryNumber: true } },
    },
    orderBy: [{ date: "desc" }, { number: "desc" }],
    take: 1000,
  })
  return rows.map((t) => ({
    id: t.id,
    number: t.number,
    type: t.type,
    status: t.status,
    date: t.date.toISOString().slice(0, 10),
    period: `${t.period.year}-${String(t.period.month).padStart(2, "0")}`,
    periodClosed: t.period.status === "CLOSED" || t.period.status === "LOCKED",
    description: t.description,
    amount: t.amount.toString(),
    currency: t.currency,
    fxRate: t.fxRateToBase.toString(),
    baseAmount: t.baseAmount.toString(),
    fee: t.feeAmount.toString(),
    financialAccountId: t.financialAccountId,
    financialAccount: t.financialAccount?.name ?? null,
    counterFinancialAccountId: t.counterFinancialAccountId,
    counterFinancialAccount: t.counterFinancialAccount?.name ?? null,
    categoryId: t.categoryId,
    category: t.category ? (t.category.parent ? `${t.category.parent.name} › ${t.category.name}` : t.category.name) : null,
    debitAccountId: t.debitAccountId,
    creditAccountId: t.creditAccountId,
    departmentId: t.departmentId,
    department: t.department?.name ?? null,
    clientId: t.clientId,
    client: t.client?.name ?? null,
    projectId: t.projectId,
    project: t.project?.name ?? null,
    shareholderId: t.shareholderId,
    shareholder: t.shareholder?.name ?? null,
    counterparty: t.counterparty,
    direction: t.direction,
    settlementStatus: t.settlementStatus,
    settled: t.settledAmount.toString(),
    dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
    notes: t.notes,
    attachmentUrl: t.attachmentUrl,
    journalEntryNumber: t.journalEntry?.entryNumber ?? null,
  }))
}

/** Reference lists for transaction forms (all active, so new departments/categories appear automatically). */
export async function transactionOptions(user: SessionUser, db: Db = prisma) {
  const org = user.organizationId
  const [accounts, categories, ledgerAccounts, departments, clients, projects, shareholders] = await Promise.all([
    db.financialAccount.findMany({ where: { organizationId: org, closedAt: null }, orderBy: { name: "asc" } }),
    db.financialCategory.findMany({ where: { organizationId: org, archivedAt: null }, include: { parent: { select: { name: true } } }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }] }),
    db.ledgerAccount.findMany({ where: { organizationId: org, isPostable: true, archivedAt: null }, orderBy: { code: "asc" } }),
    db.department.findMany({ where: { organizationId: org, archivedAt: null }, orderBy: { name: "asc" } }),
    db.client.findMany({ where: { organizationId: org, archivedAt: null }, orderBy: { name: "asc" } }),
    db.project.findMany({ where: { organizationId: org, billingModel: { not: "INTERNAL" } }, orderBy: { name: "asc" } }),
    db.shareholder.findMany({ where: { organizationId: org, archivedAt: null }, orderBy: { name: "asc" } }),
  ])
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, type: a.type })),
    categories: categories.map((c) => ({ id: c.id, name: c.parent ? `${c.parent.name} › ${c.name}` : c.name, kind: c.kind, code: c.code })),
    ledgerAccounts: ledgerAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype })),
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
    clients: clients.map((c) => ({ id: c.id, name: c.name })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    shareholders: shareholders.map((s) => ({ id: s.id, name: s.name })),
  }
}

/** Stable key for imported rows so re-importing the same file never duplicates transactions. */
export function importKey(parts: (string | null | undefined)[]) {
  return createHash("sha256").update(parts.map((p) => (p ?? "").trim().toLowerCase()).join("|")).digest("hex").slice(0, 32)
}
