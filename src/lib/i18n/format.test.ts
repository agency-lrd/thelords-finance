import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatAmount, normalizeNumber } from "./format"

describe("formatAmount", () => {
  it("formats like the spreadsheet in Russian and English", () => {
    assert.equal(formatAmount("1200", "USD", "ru"), "$1 200,00")
    assert.equal(formatAmount("1200.005", "USD", "en"), "$1,200.01")
    assert.equal(formatAmount("-50.5", "USD", "en"), "−$50.50")
    assert.equal(formatAmount("999.995", "USD", "en"), "$1,000.00")
    assert.equal(formatAmount("4000", "USDT", "en"), "4,000.00 USDT")
    assert.equal(formatAmount("0", "USD", "en", { blankZero: true }), "—")
    assert.equal(formatAmount(null, "USD", "en"), "—")
  })
})

describe("normalizeNumber", () => {
  it("reads spreadsheet input in either locale", () => {
    assert.equal(normalizeNumber("$1 200,00"), "1200.00")
    assert.equal(normalizeNumber("1,200.50"), "1200.50")
    assert.equal(normalizeNumber("1.200,50"), "1200.50")
    assert.equal(normalizeNumber("1200,5"), "1200.5")
    assert.equal(normalizeNumber("12,000"), "12000")
    assert.equal(normalizeNumber("4 000 USDT"), "4000")
    assert.equal(normalizeNumber("−300"), "-300")
    assert.equal(normalizeNumber(""), "")
    assert.equal(normalizeNumber("abc"), null)
  })
})
