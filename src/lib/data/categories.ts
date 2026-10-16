import "server-only"

import type { AccountSubtype, CategoryKind } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"

import { audit, uniqueCode } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Income and expense categories (with subcategories) and the P&L lines they report to. A category
 * always posts to a ledger account; the account's subtype decides where it appears in the P&L, cash
 * flow and EBITDA. New categories and lines are available in every form and report immediately; past
 * entries keep the account they were posted to.
 */

export const KIND_SUBTYPE: Record<CategoryKind, AccountSubtype> = {
  REVENUE: "OPERATING_REVENUE",
  OTHER_INCOME: "OTHER_INCOME",
  COST_OF_SALES: "COST_OF_SALES",
  OPERATING_EXPENSE: "OPERATING_EXPENSE",
  DEPRECIATION: "DEPRECIATION",
  AMORTIZATION: "AMORTIZATION",
  INTEREST: "INTEREST_EXPENSE",
  TAX: "INCOME_TAX",
  OTHER_EXPENSE: "OTHER_EXPENSE",
}
const CODE_RANGE: Record<AccountSubtype, [number, number]> = {
  OPERATING_REVENUE: [4000, 4899],
  OTHER_INCOME: [4900, 4999],
  COST_OF_SALES: [5000, 5999],
  OPERATING_EXPENSE: [6000, 6999],
  DEPRECIATION: [7000, 7099],
  AMORTIZATION: [7100, 7199],
  INTEREST_EXPENSE: [8000, 8099],
  INCOME_TAX: [9000, 9099],
  OTHER_EXPENSE: [8500, 8999],
} as Record<AccountSubtype, [number, number]>

function need(user: SessionUser) {
  if (!user.permissions.has("ledger:manage")) throw new UserInputError("You do not have permission to manage categories.")
}

export async function listCategoryTree(user: SessionUser, db: Db = prisma) {
  const [categories, accounts] = await Promise.all([
    db.financialCategory.findMany({ where: { organizationId: user.organizationId }, include: { ledgerAccount: { select: { id: true, code: true, name: true } } }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }] }),
    db.ledgerAccount.findMany({ where: { organizationId: user.organizationId, type: { in: ["REVENUE", "EXPENSE"] }, archivedAt: null }, orderBy: { code: "asc" } }),
  ])
  return {
    categories: categories.map((c) => ({ id: c.id, code: c.code, name: c.name, kind: c.kind, parentId: c.parentId, archived: !!c.archivedAt, account: c.ledgerAccount ? { id: c.ledgerAccount.id, label: `${c.ledgerAccount.code} ${c.ledgerAccount.name}` } : null })),
    accounts: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, subtype: a.subtype })),
  }
}

async function newLine(tx: Parameters<Parameters<typeof inTx>[1]>[0], user: SessionUser, kind: CategoryKind, name: string) {
  const subtype = KIND_SUBTYPE[kind]
  const [lo, hi] = CODE_RANGE[subtype]
  const used = new Set((await tx.ledgerAccount.findMany({ where: { organizationId: user.organizationId }, select: { code: true } })).map((a) => a.code))
  let code = lo + 10
  while (code <= hi && used.has(String(code))) code += 10
  if (code > hi) {
    code = lo + 1
    while (code <= hi && used.has(String(code))) code++
  }
  if (code > hi) throw new UserInputError("No free account code for this kind of line.")
  return tx.ledgerAccount.create({
    data: {
      organizationId: user.organizationId,
      code: String(code),
      name,
      type: kind === "REVENUE" || kind === "OTHER_INCOME" ? "REVENUE" : "EXPENSE",
      subtype,
      normalBalance: kind === "REVENUE" || kind === "OTHER_INCOME" ? "CREDIT" : "DEBIT",
      cashFlowActivity: "OPERATING",
    },
  })
}

/** Creates a category or subcategory. ledgerAccountId: existing P&L line; "new": a new line with the category's name. */
export async function createCategory(user: SessionUser, input: { name: string; kind: CategoryKind; parentId: string | null; ledgerAccountId: string | "new" | null }, db: Db = prisma) {
  need(user)
  const name = input.name.trim()
  if (!name || name.length > 120) throw new UserInputError("Enter a category name.")
  if (!KIND_SUBTYPE[input.kind]) throw new UserInputError("Choose a category type.")
  return inTx(db, async (tx) => {
    let ledgerAccountId: string | null = null
    let parentAccount: string | null = null
    if (input.parentId) {
      const parent = await tx.financialCategory.findFirst({ where: { id: input.parentId, organizationId: user.organizationId } })
      if (!parent) throw new UserInputError("Parent category not found.")
      if (parent.kind !== input.kind) throw new UserInputError("A subcategory must have the same type as its parent.")
      parentAccount = parent.ledgerAccountId
    }
    if (input.ledgerAccountId === "new") ledgerAccountId = (await newLine(tx, user, input.kind, name)).id
    else if (input.ledgerAccountId) {
      const account = await tx.ledgerAccount.findFirst({ where: { id: input.ledgerAccountId, organizationId: user.organizationId } })
      if (!account || account.subtype !== KIND_SUBTYPE[input.kind]) throw new UserInputError("That P&L line does not match the category type.")
      ledgerAccountId = account.id
    } else ledgerAccountId = parentAccount
    if (!ledgerAccountId) {
      const fallback = await tx.ledgerAccount.findFirst({ where: { organizationId: user.organizationId, subtype: KIND_SUBTYPE[input.kind], isPostable: true, archivedAt: null }, orderBy: { code: "asc" } })
      ledgerAccountId = fallback?.id ?? (await newLine(tx, user, input.kind, name)).id
    }
    const code = await uniqueCode(name, async (c) => Boolean(await tx.financialCategory.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })))
    const category = await tx.financialCategory.create({ data: { organizationId: user.organizationId, code, name, kind: input.kind, parentId: input.parentId, ledgerAccountId } })
    await audit(tx, user, "category.create", "financial_category", category.id, { name, kind: input.kind, ledgerAccountId })
    return category
  })
}

/**
 * Renames, re-maps or archives a category. Re-mapping changes where FUTURE postings go; posted entries
 * keep their account, so past reports do not change.
 */
export async function updateCategory(user: SessionUser, id: string, input: { name?: string; ledgerAccountId?: string; archived?: boolean }, db: Db = prisma) {
  need(user)
  return inTx(db, async (tx) => {
    const category = await tx.financialCategory.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!category) throw new UserInputError("Category not found.")
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new UserInputError("Enter a category name.")
    if (input.ledgerAccountId) {
      const account = await tx.ledgerAccount.findFirst({ where: { id: input.ledgerAccountId, organizationId: user.organizationId } })
      if (!account || account.subtype !== KIND_SUBTYPE[category.kind]) throw new UserInputError("That P&L line does not match the category type.")
    }
    await tx.financialCategory.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.ledgerAccountId ? { ledgerAccountId: input.ledgerAccountId } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      },
    })
    await audit(tx, user, "category.update", "financial_category", id, input)
  })
}
