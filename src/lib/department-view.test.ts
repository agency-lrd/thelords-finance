import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { stableGridHeight } from "./department-view"

const people = (dept: string, n: number) => Array.from({ length: n }, () => dept)

describe("stable sheet grid height in the department view", () => {
  it("is the same for every department of a month (0, 2, 10 and 30 employees)", () => {
    // One month: AI Production 2, Influence 10, Traffic CPA 30, Course launches 0 people.
    const month = [...people("ai", 2), ...people("influence", 10), ...people("traffic", 30)]
    const height = stableGridHeight(month)
    // The grid height depends on the month only, never on the selected department.
    assert.equal(height, 40 + 30 * 44 + 32 + 40 + 2)
    assert.equal(stableGridHeight([...month]), height)
  })
  it("has a sensible minimum and no excessive space for small months", () => {
    assert.equal(stableGridHeight([]), 320)
    assert.equal(stableGridHeight(people("ai", 2)), 320)
    assert.equal(stableGridHeight(people("ai", 10)), 40 + 10 * 44 + 32 + 40 + 2)
  })
  it("with the combined view, sized for all rows plus one subtotal per department", () => {
    const month = [...people("ai", 2), ...people("influence", 10), ...people("traffic", 30)]
    assert.equal(stableGridHeight(month, { combined: true }), 40 + 42 * 44 + 3 * 32 + 40 + 2)
  })
  it("counts employees without a department as their own group", () => {
    assert.equal(stableGridHeight([null, null, null, ...people("ai", 1)]), 320)
  })
})
