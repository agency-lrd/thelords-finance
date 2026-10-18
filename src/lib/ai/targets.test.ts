import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { marginOpportunities } from "./diagnostics"
import { targetGap, whatIf, type Baseline } from "./targets"

// Monthly baseline: revenue 100k; cost of services 40k (of which 10k delivery payroll, so 30k variable);
// opex 30k (of which 20k payroll); EBITDA 30k; D&A 2k; no tax. Cash 120k; net cash flow 10k a month.
const base: Baseline = {
  months: ["2026-07", "2026-08", "2026-09"],
  revenue: "100000",
  costOfServices: "40000",
  operatingExpenses: "30000",
  payrollCostOfServices: "10000",
  payrollOperating: "20000",
  depreciationAndAmortization: "2000",
  nonOperating: "0",
  incomeTax: "0",
  netCashFlow: "10000",
  cash: "120000",
}
const none = { netProfitMonthly: null, revenueMonthly: null, ebitdaMarginPct: null, cashReserveMonths: null }
const path = (r: ReturnType<typeof targetGap>, name: string) => r.paths.find((p) => p.path === name)!

describe("targetGap", () => {
  it("net profit target: EBITDA gap and the ways to close it", () => {
    const r = targetGap(base, { ...none, netProfitMonthly: "50000" })
    assert.deepEqual(r.kpis[0], { metric: "netProfitMonthly", current: "28000", target: "50000", gap: "22000", gapPct: 78.6, reached: false })
    assert.equal(r.baseline.variableCostRatioPct, 30)
    assert.equal(r.baseline.fixedCosts, "40000")
    // Revenue only: 22,000 / 70% contribution = 31,428.57
    assert.equal(path(r, "revenue_only").values.revenueIncrease, "31428.57")
    assert.equal(path(r, "revenue_only").values.revenueIncreasePct, 31.4)
    assert.equal(path(r, "cost_only").values.fixedCostCut, "22000")
    assert.equal(path(r, "cost_only").values.fixedCostCutPct, 55)
    assert.equal(path(r, "balanced").values.fixedCostCut, "11000")
    assert.equal(path(r, "balanced").values.revenueIncrease, "15714.29")
    assert.equal(path(r, "gross_margin").values.grossMarginIncreasePoints, 22)
    assert.equal(path(r, "gross_margin").feasible, true)
  })

  it("accounts for tax when the business pays it", () => {
    const taxed = { ...base, incomeTax: "5600" } // 20% of 28,000 profit before tax
    const r = targetGap(taxed, { ...none, netProfitMonthly: "40000" })
    assert.equal(r.kpis[0].current, "22400")
    assert.equal(path(r, "cost_only").values.fixedCostCut, "22000") // needs 50,000 PBT = 52,000 EBITDA
  })

  it("revenue, EBITDA margin and cash reserve targets", () => {
    const r = targetGap(base, { netProfitMonthly: null, revenueMonthly: "120000", ebitdaMarginPct: "40", cashReserveMonths: "6" })
    assert.deepEqual(r.kpis.map((k) => [k.metric, k.current, k.gap, k.reached]), [["revenueMonthly", "100000", "20000", false], ["ebitdaMarginPct", "30", "10", false], ["cashReserveMonths", "1.71", "4.29", false]])
    assert.equal(path(r, "revenue_at_current_margins").values.ebitdaAtTarget, "44000")
    assert.equal(path(r, "cost_cut_at_current_revenue").values.fixedCostCut, "10000")
    assert.equal(path(r, "revenue_at_current_costs").values.revenueNeeded, "133333.33") // 40,000 / (70% - 40%)
    const reserve = path(r, "build_reserve").values
    assert.equal(reserve.requiredCash, "420000")
    assert.equal(reserve.shortfall, "300000")
    assert.equal(reserve.monthsAtCurrentCashFlow, 30)
  })

  it("says when a margin is not reachable by revenue alone, and marks reached targets", () => {
    const r = targetGap(base, { ...none, ebitdaMarginPct: "75", revenueMonthly: "90000" })
    assert.equal(r.kpis.find((k) => k.metric === "revenueMonthly")!.reached, true)
    const p = path(r, "revenue_at_current_costs")
    assert.equal(p.feasible, false)
    assert.match(p.note!, /Not reachable/)
  })
})

describe("whatIf", () => {
  it("price rise: revenue and variable costs move, fixed costs stay", () => {
    const r = whatIf(base, { revenuePct: 10, costOfServicesPct: 0, operatingExpensesPct: 0, payrollPct: 0 })
    assert.equal(r.monthly.after.revenue, "110000")
    assert.equal(r.monthly.after.costOfServices, "43000")
    assert.equal(r.monthly.after.ebitda, "37000")
    assert.equal(r.monthly.delta.ebitda, "7000")
    assert.equal(r.monthly.delta.cashFlow, "7000")
    assert.equal(r.monthly.after.ebitdaMarginPct, 33.6)
  })
  it("payroll and cost changes", () => {
    const r = whatIf(base, { revenuePct: 0, costOfServicesPct: -10, operatingExpensesPct: -20, payrollPct: 15 })
    // payroll 30,000 -> 34,500; variable 30,000 -> 27,000; other opex 10,000 -> 8,000
    assert.equal(r.monthly.after.payroll, "34500")
    assert.equal(r.monthly.after.ebitda, "30500")
    assert.equal(r.monthly.delta.netProfit, "500")
  })
})

describe("marginOpportunities", () => {
  it("finds cost growth, low-margin clients, loss-making departments and large lines, ranked by impact", () => {
    const ops = marginOpportunities({
      revenue: "100000",
      grossMarginPct: "60",
      totalExpenses: "70000",
      expenses: [
        { accountId: "a1", account: "6100 Software", section: "operatingExpenses", current: "12000", previous: "8000" },
        { accountId: "a2", account: "6200 Rent", section: "operatingExpenses", current: "8000", previous: "8000" },
        { accountId: "a3", account: "6300 Fees", section: "operatingExpenses", current: "300", previous: "100" },
      ],
      clients: [
        { id: "c1", name: "Thin", revenue: "20000", contribution: "2000" },
        { id: "c2", name: "Fine", revenue: "50000", contribution: "35000" },
        { id: "c3", name: "Tiny", revenue: "1000", contribution: "0" },
      ],
      departments: [{ id: "d1", name: "Clipping", revenue: "5000", netProfit: "-3000" }],
      previousHasData: true,
    })
    assert.deepEqual(ops.map((o) => [o.code, o.subject.name, o.estimatedImpact]), [
      ["low_margin_client", "Thin", "10000"], // 20,000 x (60% - 10%)
      ["expense_back_to_previous", "6100 Software", "4000"],
      ["department_to_breakeven", "Clipping", "3000"],
      ["large_cost_line", "6100 Software", "1200"],
      ["large_cost_line", "6200 Rent", "800"],
    ])
  })
  it("compares with the previous period only when it has data", () => {
    const ops = marginOpportunities({ revenue: "100", grossMarginPct: null, totalExpenses: "12000", expenses: [{ accountId: "a1", account: "X", section: "costOfServices", current: "12000", previous: "0" }], clients: [], departments: [], previousHasData: false })
    assert.deepEqual(ops, [])
  })
})
