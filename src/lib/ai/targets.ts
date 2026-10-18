/**
 * Business targets and what-if scenarios for the AI CFO. Pure and deterministic: the gap between a
 * monthly baseline (average of the last complete months) and a target, the ways to close it, and the
 * effect of a change in revenue, costs or payroll. Every result carries its assumptions; the AI turns
 * them into an action plan but never computes the numbers itself.
 *
 * Cost model (monthly):
 *  - Variable costs: non-payroll cost of services, assumed to move with revenue.
 *  - Fixed costs: operating expenses (including their payroll) and delivery payroll (payroll booked
 *    under cost of services).
 *  - EBITDA = revenue - variable costs - fixed costs.
 *  - Net profit = (EBITDA - D&A + other income/expense) x (1 - effective tax rate) when positive.
 */
import Decimal from "decimal.js"

export type Baseline = {
  months: string[]
  revenue: string
  costOfServices: string
  operatingExpenses: string
  /** Payroll inside cost of services and inside operating expenses. */
  payrollCostOfServices: string
  payrollOperating: string
  depreciationAndAmortization: string
  nonOperating: string
  incomeTax: string
  netCashFlow: string
  cash: string
}

export type Targets = { netProfitMonthly: string | null; revenueMonthly: string | null; ebitdaMarginPct: string | null; cashReserveMonths: string | null }

const D = (v: Decimal.Value) => new Decimal(v)
const r2 = (d: Decimal) => d.toDecimalPlaces(2).toString()
const pctOf = (part: Decimal, whole: Decimal) => (whole.isZero() ? null : part.div(whole.abs()).mul(100).toDecimalPlaces(1).toNumber())

function model(b: Baseline) {
  const R = D(b.revenue)
  const variable = D(b.costOfServices).sub(b.payrollCostOfServices)
  const fixed = D(b.operatingExpenses).add(b.payrollCostOfServices)
  const ebitda = R.sub(b.costOfServices).sub(b.operatingExpenses)
  const pbt = ebitda.sub(b.depreciationAndAmortization).add(b.nonOperating)
  const taxRate = pbt.isPositive() ? Decimal.min(D(0.5), Decimal.max(D(0), D(b.incomeTax).div(pbt))) : D(0)
  const netProfit = pbt.sub(pbt.isPositive() ? pbt.mul(taxRate) : 0)
  const variableRatio = R.isPositive() ? variable.div(R) : D(0)
  return { R, variable, fixed, ebitda, pbt, taxRate, netProfit, variableRatio, contribution: D(1).sub(variableRatio) }
}

export const MODEL_ASSUMPTIONS = [
  "Baseline: monthly average of the last complete months with posted data.",
  "Non-payroll cost of services moves with revenue (variable); operating expenses and delivery payroll are fixed.",
  "Tax: the baseline effective rate on positive profit before tax; D&A and other income/expense stay at the baseline.",
  "Cash effects ignore the timing of receivables and payables.",
]

/** Gap between the baseline and each target that is set, with the ways to close it. */
export function targetGap(b: Baseline, t: Targets) {
  const m = model(b)
  const kpis: { metric: string; current: string; target: string; gap: string; gapPct: number | null; reached: boolean }[] = []
  const paths: { target: string; path: string; values: Record<string, string | number | null>; feasible: boolean; note?: string }[] = []
  const kpi = (metric: string, current: Decimal, target: Decimal) => {
    const gap = target.sub(current)
    kpis.push({ metric, current: r2(current), target: r2(target), gap: r2(gap), gapPct: pctOf(gap, current), reached: gap.lte(0) })
    return gap
  }

  if (t.netProfitMonthly !== null) {
    const target = D(t.netProfitMonthly)
    const gap = kpi("netProfitMonthly", m.netProfit, target)
    if (gap.isPositive()) {
      // EBITDA needed for the target net profit, given tax, D&A and other income/expense.
      const pbtNeeded = target.isPositive() ? target.div(D(1).sub(m.taxRate)) : target
      const ebitdaNeeded = pbtNeeded.add(b.depreciationAndAmortization).sub(b.nonOperating)
      const ebitdaGap = ebitdaNeeded.sub(m.ebitda)
      const revenueFeasible = m.contribution.isPositive()
      const dR = revenueFeasible ? ebitdaGap.div(m.contribution) : null
      paths.push({ target: "netProfitMonthly", path: "revenue_only", feasible: revenueFeasible, values: { ebitdaNeeded: r2(ebitdaNeeded), ebitdaGap: r2(ebitdaGap), revenueIncrease: dR ? r2(dR) : null, revenueIncreasePct: dR ? pctOf(dR, m.R) : null, newRevenue: dR ? r2(m.R.add(dR)) : null } })
      paths.push({ target: "netProfitMonthly", path: "cost_only", feasible: ebitdaGap.lte(m.fixed), values: { fixedCostCut: r2(ebitdaGap), fixedCostCutPct: pctOf(ebitdaGap, m.fixed), ofOperatingExpensesPct: pctOf(ebitdaGap, D(b.operatingExpenses)) }, note: ebitdaGap.gt(m.fixed) ? "The gap is larger than all fixed costs." : undefined })
      if (revenueFeasible) {
        const half = ebitdaGap.div(2)
        paths.push({ target: "netProfitMonthly", path: "balanced", feasible: half.lte(m.fixed), values: { revenueIncrease: r2(half.div(m.contribution)), revenueIncreasePct: pctOf(half.div(m.contribution), m.R), fixedCostCut: r2(half), fixedCostCutPct: pctOf(half, m.fixed) } })
      }
      if (m.R.isPositive()) {
        const marginPoints = ebitdaGap.div(m.R).mul(100)
        paths.push({ target: "netProfitMonthly", path: "gross_margin", feasible: marginPoints.lte(m.variableRatio.mul(100)), values: { grossMarginIncreasePoints: marginPoints.toDecimalPlaces(1).toNumber(), variableCostCut: r2(ebitdaGap) } })
      }
    }
  }

  if (t.revenueMonthly !== null) {
    const target = D(t.revenueMonthly)
    const gap = kpi("revenueMonthly", m.R, target)
    if (gap.isPositive()) {
      const ebitdaAtTarget = target.mul(m.contribution).sub(m.fixed)
      paths.push({ target: "revenueMonthly", path: "revenue_at_current_margins", feasible: true, values: { revenueIncrease: r2(gap), revenueIncreasePct: pctOf(gap, m.R), ebitdaAtTarget: r2(ebitdaAtTarget), ebitdaChange: r2(ebitdaAtTarget.sub(m.ebitda)) } })
    }
  }

  if (t.ebitdaMarginPct !== null) {
    const target = D(t.ebitdaMarginPct).div(100)
    const current = m.R.isPositive() ? m.ebitda.div(m.R).mul(100) : D(0)
    const gap = kpi("ebitdaMarginPct", current, target.mul(100))
    if (gap.isPositive() && m.R.isPositive()) {
      const cut = target.mul(m.R).sub(m.ebitda)
      paths.push({ target: "ebitdaMarginPct", path: "cost_cut_at_current_revenue", feasible: cut.lte(m.fixed), values: { fixedCostCut: r2(cut), fixedCostCutPct: pctOf(cut, m.fixed) } })
      const room = m.contribution.sub(target)
      const revenueNeeded = room.isPositive() ? m.fixed.div(room) : null
      paths.push({
        target: "ebitdaMarginPct",
        path: "revenue_at_current_costs",
        feasible: revenueNeeded !== null,
        values: { revenueNeeded: revenueNeeded ? r2(revenueNeeded) : null, revenueIncreasePct: revenueNeeded ? pctOf(revenueNeeded.sub(m.R), m.R) : null },
        note: revenueNeeded ? undefined : "Not reachable by revenue alone: the target margin is above the contribution margin.",
      })
    }
  }

  if (t.cashReserveMonths !== null) {
    const monthlyCosts = D(b.costOfServices).add(b.operatingExpenses)
    const required = monthlyCosts.mul(t.cashReserveMonths)
    const cash = D(b.cash)
    const currentMonths = monthlyCosts.isPositive() ? cash.div(monthlyCosts) : D(0)
    kpi("cashReserveMonths", currentMonths, D(t.cashReserveMonths))
    const shortfall = required.sub(cash)
    if (shortfall.isPositive()) {
      const flow = D(b.netCashFlow)
      paths.push({
        target: "cashReserveMonths",
        path: "build_reserve",
        feasible: flow.isPositive(),
        values: { requiredCash: r2(required), shortfall: r2(shortfall), monthlyCosts: r2(monthlyCosts), monthsAtCurrentCashFlow: flow.isPositive() ? shortfall.div(flow).toDecimalPlaces(1).toNumber() : null, monthlySavingFor6Months: r2(shortfall.div(6)), monthlySavingFor12Months: r2(shortfall.div(12)) },
        note: flow.isPositive() ? undefined : "The recent average net cash flow is not positive: the reserve does not grow without changes.",
      })
    }
  }

  return {
    baseline: { months: b.months, revenue: b.revenue, ebitda: r2(m.ebitda), ebitdaMarginPct: pctOf(m.ebitda, m.R), netProfit: r2(m.netProfit), variableCostRatioPct: m.variableRatio.mul(100).toDecimalPlaces(1).toNumber(), fixedCosts: r2(m.fixed), effectiveTaxRatePct: m.taxRate.mul(100).toDecimalPlaces(1).toNumber(), cash: b.cash, netCashFlow: b.netCashFlow },
    kpis,
    paths,
    assumptions: MODEL_ASSUMPTIONS,
  }
}

export type ScenarioChanges = { revenuePct: number; costOfServicesPct: number; operatingExpensesPct: number; payrollPct: number }

/**
 * What-if on the monthly baseline. revenuePct moves revenue (and the variable costs with it);
 * costOfServicesPct and operatingExpensesPct change the non-payroll parts; payrollPct changes all payroll.
 */
export function whatIf(b: Baseline, c: ScenarioChanges) {
  const base = model(b)
  const R = D(b.revenue).mul(1 + c.revenuePct / 100)
  const variable = base.variable.mul(1 + c.revenuePct / 100).mul(1 + c.costOfServicesPct / 100)
  const payrollCos = D(b.payrollCostOfServices).mul(1 + c.payrollPct / 100)
  const payrollOpex = D(b.payrollOperating).mul(1 + c.payrollPct / 100)
  const otherOpex = D(b.operatingExpenses).sub(b.payrollOperating).mul(1 + c.operatingExpensesPct / 100)
  const cos = variable.add(payrollCos)
  const opex = otherOpex.add(payrollOpex)
  const ebitda = R.sub(cos).sub(opex)
  const ebit = ebitda.sub(b.depreciationAndAmortization)
  const pbt = ebit.add(b.nonOperating)
  const tax = pbt.isPositive() ? pbt.mul(base.taxRate) : D(0)
  const net = pbt.sub(tax)
  const baseTax = base.pbt.isPositive() ? base.pbt.mul(base.taxRate) : D(0)
  const cashFlow = D(b.netCashFlow).add(ebitda.sub(base.ebitda)).sub(tax.sub(baseTax))
  const row = (revenue: Decimal, cs: Decimal, op: Decimal, payroll: Decimal, e: Decimal, et: Decimal, n: Decimal, cf: Decimal) => ({
    revenue: r2(revenue),
    costOfServices: r2(cs),
    operatingExpenses: r2(op),
    payroll: r2(payroll),
    ebitda: r2(e),
    ebitdaMarginPct: pctOf(e, revenue),
    ebit: r2(et),
    netProfit: r2(n),
    netMarginPct: pctOf(n, revenue),
    cashFlow: r2(cf),
  })
  const before = row(base.R, D(b.costOfServices), D(b.operatingExpenses), D(b.payrollCostOfServices).add(b.payrollOperating), base.ebitda, base.ebitda.sub(b.depreciationAndAmortization), base.netProfit, D(b.netCashFlow))
  const after = row(R, cos, opex, payrollCos.add(payrollOpex), ebitda, ebit, net, cashFlow)
  const delta = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, typeof v === "string" ? r2(D(v).sub((before as Record<string, string | number | null>)[k] as string)) : v === null || before[k as keyof typeof before] === null ? null : Math.round(((v as number) - (before[k as keyof typeof before] as number)) * 10) / 10]))
  return { changes: c, monthly: { before, after, delta }, assumptions: MODEL_ASSUMPTIONS }
}
