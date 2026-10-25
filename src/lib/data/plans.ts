import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import type { Month } from "@/lib/period"
import { cashFlowReport, pnlReport } from "@/lib/reports/ledger"
import { range } from "@/lib/reports/periods"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Financial plans inside AI CFO: a named plan for a month with its assumptions and targets. "Зафиксировать
 * план" fixes it (the database then refuses any change; it can only be archived), so plan vs actual stays
 * honest. Plans are planning records: they never create or change transactions, payroll or the ledger.
 */

export type PlanInput = {
  name: string
  month: Month
  assumptions: string | null
  revenue: Decimal | null
  directCosts: Decimal | null
  operatingExpenses: Decimal | null
  payroll: Decimal | null
  hiringCost: Decimal | null
  profit: Decimal | null
  cashBalance: Decimal | null
}

function requirePlanning(user: SessionUser) {
  if (!user.permissions.has("ledger:manage")) throw new UserInputError("You do not have permission to save plans.")
}

const num = (v: Decimal | null) => (v === null ? null : v.toDecimalPlaces(2).toString())

/** Expected profit when not given: revenue - direct costs - operating expenses - payroll - hiring. */
export function expectedProfit(p: Pick<PlanInput, "revenue" | "directCosts" | "operatingExpenses" | "payroll" | "hiringCost">) {
  if (p.revenue === null) return null
  return [p.directCosts, p.operatingExpenses, p.payroll, p.hiringCost].reduce<Decimal>((a, v) => (v ? a.sub(v) : a), p.revenue)
}

export async function savePlan(user: SessionUser, input: PlanInput & { id?: string | null; fix: boolean }, db: Db = prisma) {
  requirePlanning(user)
  const name = input.name.trim()
  if (!name || name.length > 120) throw new UserInputError("Enter a plan name (max 120 characters).")
  if (!input.revenue && !input.directCosts && !input.operatingExpenses && !input.payroll && !input.profit && !input.cashBalance) throw new UserInputError("Enter at least one planned figure.")
  const data = {
    name,
    year: input.month.year,
    month: input.month.month,
    assumptions: input.assumptions?.trim().slice(0, 4000) || null,
    revenue: num(input.revenue),
    directCosts: num(input.directCosts),
    operatingExpenses: num(input.operatingExpenses),
    payroll: num(input.payroll),
    hiringCost: num(input.hiringCost),
    profit: num(input.profit ?? expectedProfit(input)),
    cashBalance: num(input.cashBalance),
    ...(input.fix ? { fixedAt: new Date(), fixedById: user.id } : {}),
  }
  return inTx(db, async (tx) => {
    if (input.id) {
      const current = await tx.financialPlan.findFirst({ where: { id: input.id, organizationId: user.organizationId } })
      if (!current) throw new UserInputError("Plan not found.")
      if (current.fixedAt) throw new UserInputError("This plan is fixed and cannot be changed. Save a new version instead.")
      await tx.financialPlan.update({ where: { id: input.id }, data })
      await audit(tx, user, input.fix ? "plan.fix" : "plan.update", "financial_plan", input.id, { name })
      return input.id
    }
    const plan = await tx.financialPlan.create({ data: { ...data, organizationId: user.organizationId, createdById: user.id } })
    await audit(tx, user, input.fix ? "plan.fix" : "plan.create", "financial_plan", plan.id, { name, month: `${data.year}-${String(data.month).padStart(2, "0")}` })
    return plan.id
  })
}

export async function archivePlan(user: SessionUser, id: string, archived: boolean, db: Db = prisma) {
  requirePlanning(user)
  return inTx(db, async (tx) => {
    const { count } = await tx.financialPlan.updateMany({ where: { id, organizationId: user.organizationId }, data: { archivedAt: archived ? new Date() : null } })
    if (!count) throw new UserInputError("Plan not found.")
    await audit(tx, user, archived ? "plan.archive" : "plan.restore", "financial_plan", id)
  })
}

const variance = (plan: string | null, actual: string) => {
  if (plan === null) return { plan: null, actual, variance: null, variancePct: null }
  const v = new Decimal(actual).sub(plan)
  return { plan, actual, variance: v.toString(), variancePct: new Decimal(plan).isZero() ? null : v.div(new Decimal(plan).abs()).mul(100).toFixed(1) }
}

/** Plans for a month with plan / actual / variance per figure (actuals from posted records only). */
export async function plansWithActuals(user: SessionUser, m: Month, db: Db = prisma) {
  if (!user.permissions.has("reports:read")) throw new UserInputError("You do not have permission to view reports.")
  const plans = await db.financialPlan.findMany({
    where: { organizationId: user.organizationId, year: m.year, month: m.month },
    include: { fixedBy: { select: { email: true } } },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
  })
  if (plans.length === 0) return []
  const r = range("month", m.year, m.month)
  const pnl = (await pnlReport(user, r, {}, db)).current
  const flow = (await cashFlowReport(user, r, db)).flow
  const payroll = [...pnl.sections.costOfServices.lines, ...pnl.sections.operatingExpenses.lines]
    .filter((l) => ["5000", "5050", "6000", "6050"].includes(l.code))
    .reduce((a, l) => a.add(l.amount), new Decimal(0))
  const s = (v: { toString(): string } | null) => (v === null ? null : v.toString())
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    assumptions: p.assumptions,
    fixedAt: p.fixedAt?.toISOString() ?? null,
    fixedBy: p.fixedBy?.email ?? null,
    archived: !!p.archivedAt,
    hiringCost: s(p.hiringCost),
    rows: {
      revenue: variance(s(p.revenue), pnl.revenue),
      directCosts: variance(s(p.directCosts), new Decimal(pnl.sections.costOfServices.total).sub(pnl.sections.costOfServices.lines.filter((l) => ["5000", "5050"].includes(l.code)).reduce((a, l) => a.add(l.amount), new Decimal(0))).toString()),
      operatingExpenses: variance(s(p.operatingExpenses), new Decimal(pnl.sections.operatingExpenses.total).sub(pnl.sections.operatingExpenses.lines.filter((l) => ["6000", "6050"].includes(l.code)).reduce((a, l) => a.add(l.amount), new Decimal(0))).toString()),
      payroll: variance(s(p.payroll), payroll.toString()),
      profit: variance(s(p.profit), pnl.netProfit),
      cashBalance: variance(s(p.cashBalance), flow.closingCash),
    },
  }))
}
