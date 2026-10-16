/**
 * Financial forecast for the AI CFO. Pure and deterministic: the same history and budgets always
 * give the same forecast, and every assumption is returned with it. The AI explains the
 * assumptions, uncertainty and risks; it never produces forecast numbers itself.
 *
 * Method (per scenario, per month):
 *  - Revenue: the scenario's budget for that month when one is set; otherwise the average of the
 *    last 3 complete months, times the scenario level, grown by the recent monthly trend
 *    (last 3 vs previous 3 months, capped at ±5% a month) plus the scenario's trend adjustment.
 *  - Cost of services: budget, else the historical share of revenue.
 *  - Operating expenses and payroll: budget, else the 3-month average times the scenario cost factor.
 *  - D&A, other income/expense: 3-month average. Tax: the historical effective rate on positive profit.
 *  - Cash flow: EBITDA + other income/expense - tax + average investing and financing flows.
 *    Closing cash accumulates from the actual cash balance today.
 * Forecasts need at least 3 complete months of history; with less, no numbers are produced.
 */
import Decimal from "decimal.js"

export type ForecastScenario = "CONSERVATIVE" | "BASE" | "AGGRESSIVE"
export const FORECAST_SCENARIOS: ForecastScenario[] = ["CONSERVATIVE", "BASE", "AGGRESSIVE"]
export const HORIZONS = [1, 3, 6, 12] as const

export type MonthActual = {
  key: string
  revenue: string
  costOfServices: string
  operatingExpenses: string
  payroll: string
  depreciationAndAmortization: string
  nonOperating: string
  incomeTax: string
  investingCash: string
  financingCash: string
}

export type BudgetMonth = { revenue: string | null; directCosts: string | null; opex: string | null; payroll: string | null }

export type ForecastInput = {
  /** Complete months, oldest first. */
  history: MonthActual[]
  openingCash: string
  /** First forecast month, "YYYY-MM". */
  startMonth: string
  months: number
  /** Budget per scenario and month key ("YYYY-MM"), when set. */
  budgets: Partial<Record<ForecastScenario, Record<string, BudgetMonth>>>
}

export const SCENARIO_RULES: Record<ForecastScenario, { revenueLevel: number; trendAdjust: number; costFactor: number }> = {
  CONSERVATIVE: { revenueLevel: 0.9, trendAdjust: -0.02, costFactor: 1.05 },
  BASE: { revenueLevel: 1, trendAdjust: 0, costFactor: 1 },
  AGGRESSIVE: { revenueLevel: 1.1, trendAdjust: 0.02, costFactor: 1 },
}

export type ForecastMonth = {
  month: string
  revenue: string
  costOfServices: string
  opex: string
  payroll: string
  ebitda: string
  ebit: string
  netProfit: string
  cashFlow: string
  closingCash: string
  /** Which lines came from the budget for this month. */
  fromBudget: string[]
}

export type HorizonTotals = { months: number; revenue: string; opex: string; payroll: string; ebitda: string; ebit: string; netProfit: string; cashFlow: string; closingCash: string; lowestClosingCash: string }

export type ForecastResult =
  | { status: "insufficient_history"; historyMonths: number; requiredMonths: number }
  | {
      status: "ok"
      historyMonths: number
      basis: { averages: Record<string, string>; monthlyTrendPct: number; costOfServicesShareOfRevenuePct: number | null; effectiveTaxRatePct: number | null; revenueVolatilityPct: number | null }
      scenarios: Record<ForecastScenario, { months: ForecastMonth[]; horizons: HorizonTotals[] }>
      assumptions: string[]
      /** Uncertainty grows with horizon and with the volatility of past revenue. */
      uncertainty: { level: "low" | "medium" | "high"; note: string }
    }

const D = (v: Decimal.Value) => new Decimal(v)
const avg = (xs: Decimal[]) => (xs.length ? xs.reduce((a, x) => a.add(x), D(0)).div(xs.length) : D(0))
const r2 = (d: Decimal) => d.toDecimalPlaces(2).toString()

function nextMonth(key: string, n: number) {
  const [y, m] = key.split("-").map(Number)
  const i = y * 12 + (m - 1) + n
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`
}

export function buildForecast(input: ForecastInput): ForecastResult {
  const h = input.history
  if (h.length < 3) return { status: "insufficient_history", historyMonths: h.length, requiredMonths: 3 }
  const last3 = h.slice(-3)
  const prev3 = h.slice(-6, -3)
  const col = (rows: MonthActual[], k: keyof MonthActual) => rows.map((r) => D(r[k]))
  const a = {
    revenue: avg(col(last3, "revenue")),
    costOfServices: avg(col(last3, "costOfServices")),
    operatingExpenses: avg(col(last3, "operatingExpenses")),
    payroll: avg(col(last3, "payroll")),
    dna: avg(col(last3, "depreciationAndAmortization")),
    nonOperating: avg(col(last3, "nonOperating")),
    investing: avg(col(last3, "investingCash")),
    financing: avg(col(last3, "financingCash")),
  }

  // Monthly trend: compound growth between the previous and the last 3-month average, capped.
  let trend = 0
  if (prev3.length === 3) {
    const before = avg(col(prev3, "revenue"))
    if (before.isPositive() && a.revenue.isPositive()) trend = Math.max(-0.05, Math.min(0.05, Math.pow(a.revenue.div(before).toNumber(), 1 / 3) - 1))
  }
  const sumRevenue = col(h, "revenue").reduce((x, y) => x.add(y), D(0))
  const cosShare = sumRevenue.isPositive() ? col(h, "costOfServices").reduce((x, y) => x.add(y), D(0)).div(sumRevenue) : null
  const pbt = h.map((r) => D(r.revenue).sub(r.costOfServices).sub(r.operatingExpenses).sub(r.depreciationAndAmortization).add(r.nonOperating))
  const positivePbt = pbt.filter((x) => x.isPositive()).reduce((x, y) => x.add(y), D(0))
  const taxRate = positivePbt.isPositive() ? Decimal.min(D(0.5), Decimal.max(D(0), col(h, "incomeTax").reduce((x, y) => x.add(y), D(0)).div(positivePbt))) : D(0)
  const revs = col(h, "revenue")
  const mean = avg(revs)
  const volatility = mean.isPositive() ? Math.sqrt(avg(revs.map((x) => x.sub(mean).pow(2))).toNumber()) / mean.toNumber() : null

  const scenarios = {} as Record<ForecastScenario, { months: ForecastMonth[]; horizons: HorizonTotals[] }>
  for (const s of FORECAST_SCENARIOS) {
    const rule = SCENARIO_RULES[s]
    const growth = trend + rule.trendAdjust
    let cash = D(input.openingCash)
    const months: ForecastMonth[] = []
    for (let i = 0; i < input.months; i++) {
      const key = nextMonth(input.startMonth, i)
      const budget = input.budgets[s]?.[key]
      const fromBudget: string[] = []
      const pick = (name: string, budgetValue: string | null | undefined, fallback: Decimal) => {
        if (budgetValue !== null && budgetValue !== undefined) {
          fromBudget.push(name)
          return D(budgetValue)
        }
        return fallback
      }
      const revenue = pick("revenue", budget?.revenue, a.revenue.mul(rule.revenueLevel).mul(Math.pow(1 + growth, i + 1)))
      const cos = pick("costOfServices", budget?.directCosts, cosShare ? revenue.mul(cosShare).mul(rule.costFactor) : a.costOfServices.mul(rule.costFactor))
      const opex = pick("opex", budget?.opex, a.operatingExpenses.mul(rule.costFactor))
      const payroll = pick("payroll", budget?.payroll, a.payroll.mul(rule.costFactor))
      const ebitda = revenue.sub(cos).sub(opex)
      const ebit = ebitda.sub(a.dna)
      const beforeTax = ebit.add(a.nonOperating)
      const tax = beforeTax.isPositive() ? beforeTax.mul(taxRate) : D(0)
      const net = beforeTax.sub(tax)
      const flow = ebitda.add(a.nonOperating).sub(tax).add(a.investing).add(a.financing)
      cash = cash.add(flow)
      months.push({ month: key, revenue: r2(revenue), costOfServices: r2(cos), opex: r2(opex), payroll: r2(payroll), ebitda: r2(ebitda), ebit: r2(ebit), netProfit: r2(net), cashFlow: r2(flow), closingCash: r2(cash), fromBudget })
    }
    const horizons = HORIZONS.filter((n) => n <= months.length).map((n) => {
      const part = months.slice(0, n)
      const sum = (k: keyof ForecastMonth) => r2(part.reduce((acc, m) => acc.add(m[k] as string), D(0)))
      return {
        months: n,
        revenue: sum("revenue"),
        opex: sum("opex"),
        payroll: sum("payroll"),
        ebitda: sum("ebitda"),
        ebit: sum("ebit"),
        netProfit: sum("netProfit"),
        cashFlow: sum("cashFlow"),
        closingCash: part[part.length - 1].closingCash,
        lowestClosingCash: r2(Decimal.min(...part.map((m) => D(m.closingCash)))),
      }
    })
    scenarios[s] = { months, horizons }
  }

  const trendPct = Math.round(trend * 1000) / 10
  const assumptions = [
    `Based on ${h.length} complete months of posted ledger data (${h[0].key} to ${h[h.length - 1].key}).`,
    `Starting cash: the actual balance of cash accounts (${r2(D(input.openingCash))}).`,
    prev3.length === 3 ? `Revenue trend: ${trendPct}% a month (last 3 vs previous 3 months, capped at ±5%).` : "Revenue trend: 0% (less than 6 months of history).",
    "Scenarios: conservative = revenue -10% and trend -2 pp/month, costs +5%; base = recent averages and trend; aggressive = revenue +10% and trend +2 pp/month, costs unchanged.",
    cosShare ? `Cost of services follows revenue at ${cosShare.mul(100).toDecimalPlaces(1)}% of it (historical share).` : "Cost of services: 3-month average (no revenue history to scale it).",
    "Operating expenses, payroll, D&A and other income/expense: 3-month averages (payroll is already part of cost of services and opex; shown separately for reference).",
    `Tax: ${taxRate.mul(100).toDecimalPlaces(1)}% effective rate on positive profit before tax.`,
    "Cash flow = EBITDA + other income/expense - tax + average investing and financing cash flows of the last 3 months. Receivables and payables timing is not modelled.",
    "Where a budget is set for a month and scenario, the budget replaces the calculated revenue, cost of services, opex or payroll for that month.",
  ]
  const level = volatility === null || volatility > 0.3 || h.length < 6 ? "high" : volatility > 0.15 ? "medium" : "low"
  return {
    status: "ok",
    historyMonths: h.length,
    basis: {
      averages: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, r2(v)])),
      monthlyTrendPct: trendPct,
      costOfServicesShareOfRevenuePct: cosShare ? cosShare.mul(100).toDecimalPlaces(1).toNumber() : null,
      effectiveTaxRatePct: taxRate.mul(100).toDecimalPlaces(1).toNumber(),
      revenueVolatilityPct: volatility === null ? null : Math.round(volatility * 1000) / 10,
    },
    scenarios,
    assumptions,
    uncertainty: {
      level,
      note: `Monthly revenue varied by ${volatility === null ? "an unknown amount" : `${Math.round(volatility * 1000) / 10}%`} around its average over ${h.length} months. Uncertainty grows with the horizon: treat 6- and 12-month figures as directional.`,
    },
  }
}
