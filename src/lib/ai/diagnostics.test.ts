import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { financialAlerts, type AlertInput, type PnlFigures } from "./diagnostics"

const pnl = (revenue: number, cos: number, opex: number, other = 0): PnlFigures => {
  const gross = revenue - cos
  const ebitda = gross - opex
  const net = ebitda - other
  const m = (v: number) => (revenue ? ((v / revenue) * 100).toFixed(1) : null)
  return { revenue: String(revenue), costOfServices: String(cos), grossProfit: String(gross), operatingExpenses: String(opex), ebitda: String(ebitda), netProfit: String(net), margins: { gross: m(gross), ebitda: m(ebitda), net: m(net) } }
}

const healthy = (): AlertInput => ({
  days: 30,
  current: pnl(100000, 40000, 30000),
  previous: pnl(98000, 39000, 29000),
  payroll: { current: "50000", previous: "49000" },
  budget: { revenue: null, directCosts: null, opex: null, payroll: null, ebitda: null, netProfit: null },
  cash: { cash: "500000", runwayMonths: null, reserve: null, receivables: "60000", overdueReceivables: "0", overduePayables: "0", payables: "20000", payrollPayable: "10000", taxes: "5000", negativeForecastMonth: null },
  departments: [{ id: "d1", name: "Clipping", revenue: "60000", netProfit: "20000", previousNetProfit: "19000" }],
  clients: [
    { id: "c1", name: "A", revenue: "25000" },
    { id: "c2", name: "B", revenue: "20000" },
    { id: "c3", name: "C", revenue: "15000" },
    { id: "c4", name: "D", revenue: "40000" },
  ],
})

const codes = (input: AlertInput) => financialAlerts(input).map((a) => a.code)

describe("financialAlerts", () => {
  it("raises nothing for a stable, profitable, well-funded month with spread-out clients", () => {
    const input = healthy()
    input.clients = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `c${i}`, name: `C${i}`, revenue: String(100000 / 6) }))
    assert.deepEqual(codes(input), [])
  })

  it("flags revenue decline with severity by depth", () => {
    const input = healthy()
    input.current = pnl(85000, 34000, 29000)
    const a = financialAlerts(input).find((x) => x.code === "revenue_decline")!
    assert.equal(a.severity, "medium")
    assert.equal(a.facts.changePct, -13.3)
    input.current = pnl(70000, 30000, 29000)
    assert.equal(financialAlerts(input).find((x) => x.code === "revenue_decline")!.severity, "high")
  })

  it("flags opex and payroll growing faster than revenue, but not when revenue grows faster", () => {
    const input = healthy()
    input.current = pnl(100000, 40000, 38000)
    input.payroll = { current: "56000", previous: "49000" }
    assert.ok(codes(input).includes("opex_growth"))
    assert.ok(codes(input).includes("payroll_growth"))
    input.current = pnl(150000, 60000, 38000)
    assert.ok(!codes(input).includes("opex_growth"))
    assert.ok(!codes(input).includes("payroll_growth"))
  })

  it("flags negative margins and a margin drop", () => {
    const input = healthy()
    input.current = pnl(100000, 110000, 30000)
    const c = codes(input)
    assert.ok(c.includes("negative_gross_margin"))
    assert.ok(c.includes("negative_ebitda"))
    assert.ok(!c.includes("net_loss"), "net loss is implied by negative EBITDA and not repeated")
    input.current = pnl(100000, 40000, 55000, 10000)
    assert.ok(codes(input).includes("net_loss"))
    assert.ok(codes(input).includes("ebitda_margin_drop"))
  })

  it("budget shortfall and overrun severities follow the thresholds", () => {
    const input = healthy()
    input.budget = { revenue: "120000", directCosts: "35000", opex: "25000", payroll: "45000", ebitda: null, netProfit: null }
    const alerts = financialAlerts(input)
    const shortfall = alerts.find((a) => a.code === "budget_revenue_shortfall")!
    assert.equal(shortfall.facts.variancePct, -16.7)
    assert.equal(shortfall.severity, "medium")
    const overruns = alerts.filter((a) => a.code === "budget_cost_overrun")
    // opex 30,000 vs 25,000 = +20% (high); cost of services 40,000 vs 35,000 = +14.3% (medium)
    assert.deepEqual(overruns.map((a) => [a.facts.metric, a.severity]), [["operatingExpenses", "high"], ["costOfServices", "medium"]])
    assert.equal(alerts.find((a) => a.code === "budget_payroll_overrun")!.facts.variancePct, 11.1)
  })

  it("flags cash risks: runway, reserve, negative forecast, obligations above cash", () => {
    const input = healthy()
    input.cash = { ...input.cash, cash: "30000", runwayMonths: "2.5", reserve: "50000", negativeForecastMonth: "2026-12", payables: "25000", payrollPayable: "10000" }
    const c = financialAlerts(input)
    assert.equal(c.find((a) => a.code === "low_runway")!.severity, "high")
    assert.equal(c.find((a) => a.code === "below_cash_reserve")!.facts.shortfall, "20000")
    assert.ok(c.some((a) => a.code === "negative_cash_forecast"))
    assert.equal(c.find((a) => a.code === "obligations_exceed_cash")!.facts.obligations, "40000")
    assert.ok(c.slice(0, 4).every((a) => a.severity === "high"), "high severity first")
  })

  it("flags receivables, payables, departments and client concentration", () => {
    const input = healthy()
    input.cash = { ...input.cash, overdueReceivables: "15000", overduePayables: "3000", receivables: "250000" }
    input.departments = [
      { id: "d1", name: "Clipping", revenue: "10000", netProfit: "-4000", previousNetProfit: "1000" },
      { id: "d2", name: "Influence", revenue: "90000", netProfit: "5000", previousNetProfit: "20000" },
    ]
    input.clients = [{ id: "c1", name: "Big", revenue: "60000" }, { id: "c2", name: "Small", revenue: "40000" }]
    const alerts = financialAlerts(input)
    const c = alerts.map((a) => a.code)
    assert.ok(c.includes("overdue_receivables"))
    assert.ok(c.includes("overdue_payables"))
    assert.equal(alerts.find((a) => a.code === "high_receivables")!.facts.daysSalesOutstanding, 75)
    assert.deepEqual(alerts.find((a) => a.code === "unprofitable_department")!.subject, { kind: "department", id: "d1", name: "Clipping" })
    assert.equal(alerts.find((a) => a.code === "department_profit_decline")!.subject!.name, "Influence")
    const conc = alerts.find((a) => a.code === "client_concentration")!
    assert.equal(conc.severity, "high")
    assert.equal(conc.facts.topClientSharePct, 60)
  })

  it("ignores changes below the minimum amount", () => {
    const input = healthy()
    input.current = pnl(50, 0, 0)
    input.previous = pnl(100, 0, 0)
    assert.ok(!codes(input).includes("revenue_decline"))
  })
})
