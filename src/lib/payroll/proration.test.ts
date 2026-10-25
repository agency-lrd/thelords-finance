import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { calculatePayroll } from "./engine"
import { payableDays } from "./proration"

const d = (s: string) => new Date(`${s}T00:00:00Z`)

describe("payableDays", () => {
  it("start on the 13th of a 31-day month: 18 of 30 days", () => {
    assert.deepEqual(payableDays({ year: 2026, month: 10 }, d("2026-10-13"), null), { days: 18, divisor: 30, full: false })
  })
  it("February and 30-day months use the same convention", () => {
    assert.equal(payableDays({ year: 2026, month: 2 }, d("2026-02-13"), null).days, 18)
    assert.equal(payableDays({ year: 2026, month: 9 }, d("2026-09-13"), null).days, 18)
  })
  it("hired before the month: full month; never more than the divisor", () => {
    assert.deepEqual(payableDays({ year: 2026, month: 10 }, d("2025-01-05"), null), { days: 30, divisor: 30, full: true })
    assert.deepEqual(payableDays({ year: 2026, month: 10 }, d("2026-10-01"), null), { days: 30, divisor: 30, full: true })
  })
  it("start day not paid when configured", () => {
    assert.equal(payableDays({ year: 2026, month: 10 }, d("2026-10-13"), null, { divisor: 30, startDayPaid: false }).days, 17)
  })
  it("termination inside the month", () => {
    assert.equal(payableDays({ year: 2026, month: 10 }, d("2025-01-01"), d("2026-10-10")).days, 10)
    assert.equal(payableDays({ year: 2026, month: 10 }, d("2026-10-13"), d("2026-10-20")).days, 8)
    assert.equal(payableDays({ year: 2026, month: 11 }, d("2025-01-01"), d("2026-10-20")).days, 0)
  })
  it("hired after the month: nothing", () => {
    assert.equal(payableDays({ year: 2026, month: 10 }, d("2026-11-02"), null).days, 0)
  })
  it("the engine prorates monthly FIX once: 1,000 × 18/30 = 600", () => {
    const r = calculatePayroll({ salary: { payBasis: "MONTHLY", amount: "1000", prorate: { days: 18, divisor: 30 } } })
    assert.equal(r.fixed.toString(), "600")
    const full = calculatePayroll({ salary: { payBasis: "MONTHLY", amount: "1000", prorate: { days: 30, divisor: 30 } } })
    assert.equal(full.fixed.toString(), "1000")
  })
})
