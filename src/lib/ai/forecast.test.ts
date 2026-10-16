import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildForecast, type MonthActual } from "./forecast"

const month = (key: string, revenue: number, extra: Partial<Record<keyof MonthActual, number>> = {}): MonthActual => ({
  key,
  revenue: String(revenue),
  costOfServices: String(extra.costOfServices ?? revenue * 0.4),
  operatingExpenses: String(extra.operatingExpenses ?? 20000),
  payroll: String(extra.payroll ?? 30000),
  depreciationAndAmortization: String(extra.depreciationAndAmortization ?? 1000),
  nonOperating: String(extra.nonOperating ?? 0),
  incomeTax: String(extra.incomeTax ?? 0),
  investingCash: String(extra.investingCash ?? 0),
  financingCash: String(extra.financingCash ?? 0),
})

const flat = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((k) => month(k, 100000))

describe("buildForecast", () => {
  it("refuses to forecast with less than 3 months of history", () => {
    assert.deepEqual(buildForecast({ history: flat.slice(0, 2), openingCash: "1000", startMonth: "2026-11", months: 12, budgets: {} }), { status: "insufficient_history", historyMonths: 2, requiredMonths: 3 })
  })

  it("base scenario on flat history repeats the recent month and accumulates cash", () => {
    const f = buildForecast({ history: flat, openingCash: "50000", startMonth: "2026-11", months: 12, budgets: {} })
    assert.equal(f.status, "ok")
    if (f.status !== "ok") return
    assert.equal(f.basis.monthlyTrendPct, 0)
    assert.equal(f.basis.costOfServicesShareOfRevenuePct, 40)
    const m = f.scenarios.BASE.months[0]
    assert.equal(m.month, "2026-11")
    assert.equal(m.revenue, "100000")
    assert.equal(m.costOfServices, "40000")
    assert.equal(m.ebitda, "40000") // 100,000 - 40,000 - 20,000
    assert.equal(m.ebit, "39000")
    assert.equal(m.cashFlow, "40000")
    assert.equal(m.closingCash, "90000")
    assert.equal(f.scenarios.BASE.months[2].month, "2027-01")
    assert.deepEqual(f.scenarios.BASE.horizons.map((h) => [h.months, h.ebitda, h.closingCash]), [[1, "40000", "90000"], [3, "120000", "170000"], [6, "240000", "290000"], [12, "480000", "530000"]])
    assert.equal(f.uncertainty.level, "low")
  })

  it("orders scenarios: conservative below base below aggressive", () => {
    const f = buildForecast({ history: flat, openingCash: "0", startMonth: "2026-11", months: 6, budgets: {} })
    if (f.status !== "ok") throw new Error("expected forecast")
    const at6 = (s: "CONSERVATIVE" | "BASE" | "AGGRESSIVE") => Number(f.scenarios[s].horizons.find((h) => h.months === 6)!.ebitda)
    assert.ok(at6("CONSERVATIVE") < at6("BASE") && at6("BASE") < at6("AGGRESSIVE"))
    assert.equal(f.scenarios.CONSERVATIVE.months[0].revenue, "88200") // 100,000 x 0.9 x (1 - 2%)
    assert.equal(f.scenarios.CONSERVATIVE.months[0].opex, "21000") // 20,000 x 1.05
    assert.deepEqual(f.scenarios.BASE.horizons.map((h) => h.months), [1, 3, 6])
  })

  it("follows the recent revenue trend, capped at 5% a month", () => {
    const rising = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((k, i) => month(k, i < 3 ? 50000 : 100000))
    const f = buildForecast({ history: rising, openingCash: "0", startMonth: "2026-10", months: 1, budgets: {} })
    if (f.status !== "ok") throw new Error("expected forecast")
    assert.equal(f.basis.monthlyTrendPct, 5)
    assert.equal(f.scenarios.BASE.months[0].revenue, "105000")
  })

  it("uses budgets where set, per scenario and month", () => {
    const f = buildForecast({
      history: flat,
      openingCash: "0",
      startMonth: "2026-11",
      months: 2,
      budgets: { BASE: { "2026-12": { revenue: "150000", directCosts: null, opex: "25000", payroll: null } } },
    })
    if (f.status !== "ok") throw new Error("expected forecast")
    const [nov, dec] = f.scenarios.BASE.months
    assert.deepEqual(nov.fromBudget, [])
    assert.deepEqual(dec.fromBudget, ["revenue", "opex"])
    assert.equal(dec.revenue, "150000")
    assert.equal(dec.costOfServices, "60000") // historical 40% of the budgeted revenue
    assert.equal(dec.opex, "25000")
    assert.equal(f.scenarios.AGGRESSIVE.months[1].fromBudget.length, 0)
  })

  it("applies the historical effective tax rate on positive profit only and adds average investing/financing", () => {
    const taxed = flat.map((m) => ({ ...m, incomeTax: "3900", investingCash: "-1000", financingCash: "-2000" })) // 10% of 39,000 profit before tax
    const f = buildForecast({ history: taxed, openingCash: "0", startMonth: "2026-11", months: 1, budgets: {} })
    if (f.status !== "ok") throw new Error("expected forecast")
    assert.equal(f.basis.effectiveTaxRatePct, 10)
    const m = f.scenarios.BASE.months[0]
    assert.equal(m.netProfit, "35100")
    assert.equal(m.cashFlow, "33100") // 40,000 EBITDA - 3,900 tax - 1,000 - 2,000
  })

  it("marks volatile or short histories as high uncertainty", () => {
    const volatile = ["2026-07", "2026-08", "2026-09"].map((k, i) => month(k, [20000, 150000, 60000][i]))
    const f = buildForecast({ history: volatile, openingCash: "0", startMonth: "2026-10", months: 3, budgets: {} })
    if (f.status !== "ok") throw new Error("expected forecast")
    assert.equal(f.uncertainty.level, "high")
    assert.ok(f.assumptions.some((a) => a.includes("less than 6 months")))
  })
})
