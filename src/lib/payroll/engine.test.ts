import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { calculatePayroll, describeRule, type RuleInput } from "./engine"

const monthly = (amount: string) => ({ payBasis: "MONTHLY" as const, amount })
const tenAboveKpi: RuleInput = {
  id: "r1",
  name: "10% of profit above KPI",
  type: "COMMISSION",
  method: "PERCENT_OF_METRIC",
  metricBasis: "ABOVE_TARGET",
  rate: "0.10",
}
const s = (value: { toFixed: (n: number) => string }) => value.toFixed(2)

describe("calculatePayroll", () => {
  it("spec example: FIX 1,200, KPI 3,000, fact 4,000, 10% above KPI -> bonus 100, total 1,300", () => {
    const r = calculatePayroll({ salary: monthly("1200"), kpi: { target: "3000", actual: "4000" }, rules: [tenAboveKpi] })
    assert.equal(s(r.fixed), "1200.00")
    assert.equal(s(r.variable), "100.00")
    assert.equal(s(r.net), "1300.00")
    assert.equal(s(r.metric), "1000.00")
    assert.equal(r.targetMet, true)
    assert.deepEqual(r.warnings, [])
  })

  it("pays nothing above KPI when the target is missed", () => {
    const r = calculatePayroll({ salary: monthly("1300"), kpi: { target: "4000", actual: "3500" }, rules: [tenAboveKpi] })
    assert.equal(s(r.variable), "0.00")
    assert.equal(s(r.net), "1300.00")
    assert.equal(r.lines.length, 1)
  })

  it("matches the sheet: Артур FIX 800, KPI 2,000, fact 3,000 -> 900", () => {
    const r = calculatePayroll({ salary: monthly("800"), kpi: { target: "2000", actual: "3000" }, rules: [tenAboveKpi] })
    assert.equal(s(r.net), "900.00")
  })

  it("percent of total profit and cap", () => {
    const rule: RuleInput = { name: "7% of profit", type: "COMMISSION", method: "PERCENT_OF_METRIC", rate: "0.07", capAmount: "500" }
    assert.equal(s(calculatePayroll({ salary: monthly("2500"), kpi: { actual: "5000" }, rules: [rule] }).variable), "350.00")
    assert.equal(s(calculatePayroll({ salary: monthly("2500"), kpi: { actual: "10000" }, rules: [rule] }).variable), "500.00")
  })

  it("conditional fixed bonus only when KPI is met", () => {
    const rule: RuleInput = { name: "KPI bonus", type: "KPI_BONUS", method: "FIXED_AMOUNT", metricBasis: "TOTAL_IF_TARGET_MET", fixedAmount: "300" }
    assert.equal(s(calculatePayroll({ salary: monthly("1000"), kpi: { target: "2000", actual: "1999.99" }, rules: [rule] }).net), "1000.00")
    assert.equal(s(calculatePayroll({ salary: monthly("1000"), kpi: { target: "2000", actual: "2000" }, rules: [rule] }).net), "1300.00")
  })

  it("tiered commission uses the tier the metric falls in", () => {
    const rule: RuleInput = {
      name: "Tiered",
      type: "COMMISSION",
      method: "TIERED",
      tiers: [
        { from: "0", to: "5000", rate: "0.05" },
        { from: "5000", to: "10000", rate: "0.08" },
        { from: "10000", rate: "0.10" },
      ],
    }
    const pay = (actual: string) => s(calculatePayroll({ salary: null, kpi: { actual }, rules: [rule] }).variable)
    assert.equal(pay("4000"), "200.00")
    assert.equal(pay("5000"), "400.00")
    assert.equal(pay("12000"), "1200.00")
  })

  it("adjustments: bonus adds, deduction subtracts, advances are excluded", () => {
    const r = calculatePayroll({
      salary: monthly("1000"),
      adjustments: [
        { type: "BONUS", amount: "150", reason: "Launch bonus" },
        { type: "DEDUCTION", amount: "50", reason: "Penalty" },
        { type: "ADVANCE", amount: "200", reason: "Advance" },
      ],
    })
    assert.equal(s(r.bonus), "150.00")
    assert.equal(s(r.deductions), "50.00")
    assert.equal(s(r.gross), "1150.00")
    assert.equal(s(r.net), "1100.00")
    assert.equal(r.warnings.length, 1)
  })

  it("hourly pay needs worked hours", () => {
    assert.equal(s(calculatePayroll({ salary: { payBasis: "HOURLY", amount: "12.5", workedHours: "160" } }).net), "2000.00")
    const missing = calculatePayroll({ salary: { payBasis: "HOURLY", amount: "12.5" } })
    assert.equal(s(missing.net), "0.00")
    assert.match(missing.warnings[0], /hours/)
  })

  it("rounds each line half-up to cents so lines add up to the total", () => {
    const rule: RuleInput = { name: "3%", type: "COMMISSION", method: "PERCENT_OF_METRIC", rate: "0.03" }
    const r = calculatePayroll({ salary: monthly("1500.005"), kpi: { actual: "333.35" }, rules: [rule] })
    assert.equal(s(r.fixed), "1500.01")
    assert.equal(s(r.variable), "10.00") // 10.0005 -> 10.00
    const total = r.lines.reduce((acc, l) => acc.add(l.amount), r.lines[0].amount.mul(0))
    assert.equal(s(total), s(r.net))
  })

  it("is exact with decimals that break floating point", () => {
    const rule: RuleInput = { name: "10%", type: "COMMISSION", method: "PERCENT_OF_METRIC", rate: "0.1" }
    assert.equal(s(calculatePayroll({ salary: monthly("0.1"), kpi: { actual: "2" }, rules: [rule] }).net), "0.30")
  })

  it("manual adjustment can reduce pay", () => {
    const r = calculatePayroll({ salary: monthly("1300"), manualAdjustment: "-100" })
    assert.equal(s(r.net), "1200.00")
  })

  it("describes rules like the sheet", () => {
    assert.equal(describeRule(tenAboveKpi), "10% от профита после KPI")
    assert.equal(describeRule({ ...tenAboveKpi, capAmount: "500" }, "en"), "10% of profit above KPI, cap $500")
  })
})
