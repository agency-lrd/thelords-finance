import "server-only"

import type { CategoryKind } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import { monthEnd, type Month } from "@/lib/period"

import { audit, uniqueCode } from "./common"
import { inTx, prisma, type Db } from "./db"

export const INCOME_KINDS: CategoryKind[] = ["REVENUE", "OTHER_INCOME"]
export const COST_KINDS: CategoryKind[] = ["COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_EXPENSE"]

// ── Departments ──

export function listDepartments(user: SessionUser, { includeArchived = false } = {}, db: Db = prisma) {
  return db.department.findMany({
    where: { organizationId: user.organizationId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { name: "asc" },
  })
}

export async function createDepartment(
  user: SessionUser,
  input: { name: string; costClassification: "COST_OF_SALES" | "OPERATING_EXPENSE"; description: string | null },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    const code = await uniqueCode(input.name, async (c) =>
      Boolean(await tx.department.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })),
    )
    const department = await tx.department.create({
      data: { organizationId: user.organizationId, code, name: input.name, description: input.description, costClassification: input.costClassification },
    })
    await audit(tx, user, "department.create", "department", department.id, { name: input.name, code })
    return department
  })
}

export async function setDepartmentArchived(user: SessionUser, id: string, archived: boolean, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const { count } = await tx.department.updateMany({
      where: { id, organizationId: user.organizationId },
      data: { archivedAt: archived ? new Date() : null },
    })
    if (!count) throw new UserInputError("Department not found.")
    await audit(tx, user, archived ? "department.archive" : "department.restore", "department", id)
  })
}

// ── Categories (configurable, hierarchical) ──

export function listCategories(user: SessionUser, kinds?: CategoryKind[], { includeArchived = false } = {}, db: Db = prisma) {
  return db.financialCategory.findMany({
    where: {
      organizationId: user.organizationId,
      ...(kinds ? { kind: { in: kinds } } : {}),
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    include: { parent: { select: { name: true } } },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  })
}

export async function createCategory(
  user: SessionUser,
  input: { name: string; kind: CategoryKind; parentId: string | null },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    if (input.parentId) {
      const parent = await tx.financialCategory.findFirst({ where: { id: input.parentId, organizationId: user.organizationId } })
      if (!parent) throw new UserInputError("Parent category not found.")
      if (parent.kind !== input.kind) throw new UserInputError("A subcategory must have the same type as its parent.")
    }
    const code = await uniqueCode(input.name, async (c) =>
      Boolean(await tx.financialCategory.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })),
    )
    const category = await tx.financialCategory.create({
      data: { organizationId: user.organizationId, code, name: input.name, kind: input.kind, parentId: input.parentId },
    })
    await audit(tx, user, "category.create", "financial_category", category.id, { name: input.name, kind: input.kind })
    return category
  })
}

export async function setCategoryArchived(user: SessionUser, id: string, archived: boolean, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const { count } = await tx.financialCategory.updateMany({
      where: { id, organizationId: user.organizationId },
      data: { archivedAt: archived ? new Date() : null },
    })
    if (!count) throw new UserInputError("Category not found.")
    await audit(tx, user, archived ? "category.archive" : "category.restore", "financial_category", id)
  })
}

// ── Clients ──

export function listClients(user: SessionUser, db: Db = prisma) {
  return db.client.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: { name: "asc" } })
}

export async function createClientRecord(user: SessionUser, input: { name: string; country: string | null }, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const code = await uniqueCode(input.name, async (c) =>
      Boolean(await tx.client.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })),
    )
    const client = await tx.client.create({
      data: { organizationId: user.organizationId, code, name: input.name, country: input.country },
    })
    await audit(tx, user, "client.create", "client", client.id, { name: input.name })
    return client
  })
}

// ── Exchange rates (stored per month on the month's last day: 1 unit of currency = rate base) ──

export function listRates(user: SessionUser, db: Db = prisma) {
  return db.exchangeRate.findMany({
    where: { organizationId: user.organizationId, quoteCurrency: user.baseCurrency },
    orderBy: [{ rateDate: "desc" }, { baseCurrency: "asc" }],
    take: 60,
  })
}

export async function setMonthlyRate(user: SessionUser, currency: string, m: Month, rate: Decimal, db: Db = prisma) {
  if (currency === user.baseCurrency) throw new UserInputError(`${currency} is the base currency; its rate is always 1.`)
  return inTx(db, async (tx) => {
    const rateDate = monthEnd(m)
    const key = { organizationId: user.organizationId, baseCurrency: currency, quoteCurrency: user.baseCurrency, rateDate }
    const saved = await tx.exchangeRate.upsert({
      where: { organizationId_baseCurrency_quoteCurrency_rateDate: key },
      create: { ...key, rate },
      update: { rate },
    })
    // Records already created keep the rate they were saved with; only new entries use the new rate.
    await audit(tx, user, "exchange_rate.set", "exchange_rate", saved.id, { currency, month: `${m.year}-${m.month}`, rate: rate.toString() })
    return saved
  })
}
