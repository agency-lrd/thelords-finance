import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Organization business targets (monthly net profit, monthly revenue, EBITDA margin, cash reserve in
 * months of costs). Read by the AI CFO gap analysis; changed only by people with ledger:manage.
 */

export type TargetValues = { netProfitMonthly: string | null; revenueMonthly: string | null; ebitdaMarginPct: string | null; cashReserveMonths: string | null }

export async function getTargets(user: SessionUser, db: Db = prisma): Promise<TargetValues & { updatedAt: string | null }> {
  if (!user.permissions.has("reports:read")) throw new UserInputError("You do not have permission to view targets.")
  const row = await db.financialTarget.findUnique({ where: { organizationId: user.organizationId } })
  const s = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : new Decimal(v.toString()).toString())
  return { netProfitMonthly: s(row?.netProfitMonthly), revenueMonthly: s(row?.revenueMonthly), ebitdaMarginPct: s(row?.ebitdaMarginPct), cashReserveMonths: s(row?.cashReserveMonths), updatedAt: row?.updatedAt.toISOString() ?? null }
}

const NUMBER = /^-?\d{1,16}(\.\d{1,2})?$/

/** Parses a target value: empty means "no target". */
export function parseTarget(raw: string | null | undefined, field: string, { min, max }: { min: number; max: number }) {
  const v = (raw ?? "").trim().replace(/[\s,]/g, "")
  if (!v) return null
  if (!NUMBER.test(v)) throw new UserInputError(`${field}: enter a number with at most 2 decimals.`)
  const d = new Decimal(v)
  if (d.lt(min) || d.gt(max)) throw new UserInputError(`${field}: must be between ${min} and ${max}.`)
  return d
}

export async function setTargets(user: SessionUser, input: Record<keyof TargetValues, string | null>, db: Db = prisma) {
  if (!user.permissions.has("ledger:manage")) throw new UserInputError("You do not have permission to change targets.")
  const data = {
    netProfitMonthly: parseTarget(input.netProfitMonthly, "Net profit per month", { min: -1e12, max: 1e12 })?.toString() ?? null,
    revenueMonthly: parseTarget(input.revenueMonthly, "Revenue per month", { min: 0, max: 1e12 })?.toString() ?? null,
    ebitdaMarginPct: parseTarget(input.ebitdaMarginPct, "EBITDA margin", { min: -100, max: 100 })?.toString() ?? null,
    cashReserveMonths: parseTarget(input.cashReserveMonths, "Cash reserve", { min: 0, max: 60 })?.toString() ?? null,
  }
  await inTx(db, async (tx) => {
    const existing = await tx.financialTarget.findUnique({ where: { organizationId: user.organizationId } })
    if (existing) await tx.financialTarget.update({ where: { organizationId: user.organizationId }, data: { ...data, updatedById: user.id } })
    else await tx.financialTarget.create({ data: { organizationId: user.organizationId, ...data, updatedById: user.id } })
    await audit(tx, user, "targets.set", "financial_targets", user.organizationId, data)
  })
}
