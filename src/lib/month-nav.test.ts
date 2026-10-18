import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { currentMonthKey, isMonthKey, monthKeyOf, shiftMonth, withMonth } from "./month-nav"

describe("month navigation", () => {
  it("shifts by months and years across year boundaries", () => {
    assert.equal(shiftMonth("2026-12", 1), "2027-01")
    assert.equal(shiftMonth("2026-01", -1), "2025-12")
    assert.equal(shiftMonth("2026-10", 12), "2027-10")
    assert.equal(shiftMonth("2026-10", -24), "2024-10")
  })
  it("validates month keys and builds them", () => {
    assert.ok(isMonthKey("2026-10"))
    for (const bad of ["2026-13", "2026-1", "1999-12", "abc", "", null]) assert.ok(!isMonthKey(bad))
    assert.equal(monthKeyOf(2026, 3), "2026-03")
    assert.equal(currentMonthKey(new Date("2026-10-18T12:00:00Z")), "2026-10")
  })
  it("keeps other URL parameters when changing the month", () => {
    assert.equal(withMonth("?month=2026-09&dept=x", "2026-10"), "?month=2026-10&dept=x")
    assert.equal(withMonth("", "2027-01"), "?month=2027-01")
  })
})
