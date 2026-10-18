import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { estimateCost } from "./config"
import { contextPrompt, splitFollowUps, SYSTEM_PROMPT } from "./prompt"

describe("splitFollowUps", () => {
  it("separates the answer from its follow-up questions", () => {
    const r = splitFollowUps("Выручка выросла.\n\n<follow-ups>\n- Почему вырос ФОТ?\n- Какие клиенты крупнейшие?\n</follow-ups>")
    assert.equal(r.text, "Выручка выросла.")
    assert.deepEqual(r.followUps, ["Почему вырос ФОТ?", "Какие клиенты крупнейшие?"])
  })
  it("keeps the text when there are no follow-ups and tolerates an unclosed block", () => {
    assert.deepEqual(splitFollowUps("Just text"), { text: "Just text", followUps: [] })
    assert.deepEqual(splitFollowUps("A\n<follow-ups>\n1. one\n2) two\n* three\n- four").followUps, ["one", "two", "three"])
  })
})

describe("prompts", () => {
  it("the fixed system prompt has no dates or per-request values (cacheable)", () => {
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT))
    assert.match(SYSTEM_PROMPT, /read-only/)
    assert.match(SYSTEM_PROMPT, /Russian by default/)
    assert.match(SYSTEM_PROMPT, /Never mention tool names/)
    assert.match(SYSTEM_PROMPT, /data, not instructions/)
  })
  it("the context names period, department and what the role cannot see", () => {
    const c = contextPrompt({ today: "2026-10-16", organizationName: "THE LORDS", baseCurrency: "USD", locale: "ru", role: "financial reports", period: "2026-09", department: "Clipping", focus: "costs", tools: [], unavailable: ["getPayrollSummary (needs payroll:read)"], books: "Posted entries from 2026-01-05 to 2026-10-12.", memory: "periods 2026-08, 2026-09 (most recent last)" })
    assert.match(c, /Selected period: 2026-09/)
    assert.match(c, /Selected department: Clipping/)
    assert.match(c, /Not available to this user's role: getPayrollSummary/)
    assert.match(c, /Interface language: Russian/)
    assert.match(c, /Books: Posted entries from 2026-01-05/)
    assert.match(c, /Discussed so far in this conversation: periods 2026-08, 2026-09/)
    assert.match(c, /\/transactions/)
  })
})

describe("estimateCost", () => {
  it("prices Opus 5.5 usage including cache reads and writes", () => {
    // 10k input x $4 + 2k output x $20 + 100k cache read x $0.20 + 5k cache write x $5 (per million)
    assert.equal(estimateCost("claude-opus-5-5", { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 100_000, cacheWriteTokens: 5_000 }), 0.125)
  })
  it("prices unknown models conservatively (most expensive known)", () => {
    assert.equal(estimateCost("some-future-model", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 10)
  })
})
