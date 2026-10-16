import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { Decimal } from "@/lib/money"

import { accountActivity, cashBalance, cashFlowReport, requireReports } from "./ledger"
import { isoDate, previous, range, type Range } from "./periods"
import { naturalAmount } from "./statements"

/*
 * Cash indicators and the cash forecast. Actual figures come from the ledger; obligations from open
 * balances (receivables, payables, payroll payable); the forecast is clearly separate and labelled.
 */

const SUBTYPE_BALANCE = async (db: Db, org: string, asOf: Date, subtypes: string[]) => {
  const activity = await accountActivity(db, org, null, asOf)
  return activity.filter((a) => subtypes.includes(a.subtype)).reduce((acc, a) => acc.add(naturalAmount(a)), new Decimal(0))
}

export async function cashIndicators(user: SessionUser, asOf: Date, db: Db = prisma) {
  requireReports(user)
  const org = user.organizationId
  const today = new Date(new Date().toISOString().slice(0, 10))
  const cash = new Decimal(await cashBalance(db, org, asOf))
  const receivables = await SUBTYPE_BALANCE(db, org, asOf, ["RECEIVABLE"])
  const payables = await SUBTYPE_BALANCE(db, org, asOf, ["PAYABLE", "ACCRUED_LIABILITY"])
  const payrollPayable = await SUBTYPE_BALANCE(db, org, asOf, ["PAYROLL_LIABILITY"])
  const taxes = await SUBTYPE_BALANCE(db, org, asOf, ["TAX_LIABILITY"])
  const distributionsPayable = await SUBTYPE_BALANCE(db, org, asOf, ["DISTRIBUTIONS_PAYABLE"])

  // Burn: average net cash outflow of the last three complete months (operating + investing).
  const asOfMonth = range("month", asOf.getUTCFullYear(), asOf.getUTCMonth() + 1)
  let r: Range = previous(asOfMonth)
  const flows: Decimal[] = []
  for (let i = 0; i < 3; i++) {
    const { flow } = await cashFlowReport(user, r, db)
    flows.push(new Decimal(flow.operating).add(flow.investing))
    r = previous(r)
  }
  const avg = flows.reduce((a, f) => a.add(f), new Decimal(0)).div(3)
  const burn = avg.isNegative() ? avg.abs() : new Decimal(0)
  const runwayMonths = burn.isZero() ? null : cash.div(burn).toDecimalPlaces(1).toString()

  // Overdue: unpaid manual transactions past their due date, and project income past due.
  const overdueTx = await db.transaction.findMany({
    where: { organizationId: org, status: "POSTED", settlementStatus: { not: "PAID" }, dueDate: { lt: today } },
    select: { type: true, amount: true, settledAmount: true, fxRateToBase: true },
  })
  const open = (t: { amount: { toString(): string }; settledAmount: { toString(): string }; fxRateToBase: { toString(): string } }) =>
    new Decimal(t.amount.toString()).sub(t.settledAmount.toString()).mul(t.fxRateToBase.toString())
  let overdueReceivables = overdueTx.filter((t) => t.type === "REVENUE").reduce((a, t) => a.add(open(t)), new Decimal(0))
  const overduePayables = overdueTx.filter((t) => t.type !== "REVENUE").reduce((a, t) => a.add(open(t)), new Decimal(0))
  const overdueIncome = await db.projectIncome.findMany({
    where: { project: { organizationId: org }, journalEntryId: { not: null }, status: { in: ["INVOICED", "PARTIALLY_RECEIVED"] }, dueDate: { lt: today } },
    select: { amount: true, receivedAmount: true, fxRateToBase: true },
  })
  for (const i of overdueIncome) overdueReceivables = overdueReceivables.add(new Decimal(i.amount.toString()).sub(i.receivedAmount.toString()).mul(i.fxRateToBase.toString()))

  return {
    cash: cash.toString(),
    receivables: receivables.toString(),
    payables: payables.toString(),
    payrollPayable: payrollPayable.toString(),
    taxes: taxes.toString(),
    distributionsPayable: distributionsPayable.toString(),
    burn: burn.toString(),
    runwayMonths,
    overdueReceivables: overdueReceivables.toDecimalPlaces(2).toString(),
    overduePayables: overduePayables.toDecimalPlaces(2).toString(),
  }
}

export type ForecastScenario = "CONSERVATIVE" | "BASE" | "AGGRESSIVE"

/**
 * Cash forecast for the next months, per scenario. Monthly net flow = the scenario's budget
 * (revenue - direct costs - opex) when one exists for that month, otherwise the 3-month average
 * operating flow adjusted by the scenario (-20% / 0 / +20% of its size). The first month also collects
 * open receivables and pays open payables and payroll. Forecast only: never mixed with actuals.
 */
export async function cashForecast(user: SessionUser, from: Date, months = 3, db: Db = prisma) {
  requireReports(user)
  const ind = await cashIndicators(user, from, db)
  const asOfMonth = range("month", from.getUTCFullYear(), from.getUTCMonth() + 1)
  let r: Range = previous(asOfMonth)
  const ops: Decimal[] = []
  for (let i = 0; i < 3; i++) {
    ops.push(new Decimal((await cashFlowReport(user, r, db)).flow.operating))
    r = previous(r)
  }
  const avg = ops.reduce((a, x) => a.add(x), new Decimal(0)).div(3)
  const budgets = await db.budgetLine.findMany({
    where: { organizationId: user.organizationId, metric: { in: ["REVENUE", "DIRECT_COSTS", "OPEX"] }, departmentId: null, projectId: null },
  })
  const out: Record<ForecastScenario, { month: string; net: string; closing: string; source: "budget" | "average" }[]> = { CONSERVATIVE: [], BASE: [], AGGRESSIVE: [] }
  for (const scenario of ["CONSERVATIVE", "BASE", "AGGRESSIVE"] as const) {
    let closing = new Decimal(ind.cash)
    let m = asOfMonth
    for (let i = 0; i < months; i++) {
      m = range("month", m.index === 12 ? m.year + 1 : m.year, m.index === 12 ? 1 : m.index + 1)
      const lines = budgets.filter((b) => b.scenario === scenario && b.year === m.year && b.month === m.index)
      let net: Decimal
      let source: "budget" | "average"
      if (lines.length) {
        const get = (metric: string) => lines.filter((b) => b.metric === metric).reduce((a, b) => a.add(b.amount.toString()), new Decimal(0))
        net = get("REVENUE").sub(get("DIRECT_COSTS")).sub(get("OPEX"))
        source = "budget"
      } else {
        const factor = scenario === "CONSERVATIVE" ? -0.2 : scenario === "AGGRESSIVE" ? 0.2 : 0
        net = avg.add(avg.abs().mul(factor))
        source = "average"
      }
      if (i === 0) net = net.add(ind.receivables).sub(ind.payables).sub(ind.payrollPayable)
      closing = closing.add(net)
      out[scenario].push({ month: m.key, net: net.toDecimalPlaces(2).toString(), closing: closing.toDecimalPlaces(2).toString(), source })
    }
  }
  return { asOf: isoDate(from), scenarios: out }
}
