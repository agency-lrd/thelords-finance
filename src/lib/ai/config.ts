/**
 * AI CFO configuration: provider key presence, model, and the token, request and spending limits.
 * Every limit has a safe default and can be changed with an environment variable (server only).
 * The API key itself is never read here beyond a presence check; the SDK reads ANTHROPIC_API_KEY.
 */

const int = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name]
  const n = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback
  return Math.min(max, Math.max(min, n))
}
const dollars = (name: string, fallback: number) => {
  const raw = process.env[name]
  const n = raw && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : fallback
  return Math.max(0, n)
}

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim())
}

export function aiLimits() {
  return {
    model: process.env.AI_CFO_MODEL?.trim() || "claude-opus-5-5",
    /** Output tokens per model call (one answer can take several calls when tools are used). */
    maxOutputTokens: int("AI_CFO_MAX_OUTPUT_TOKENS", 16000, 1000, 64000),
    /** Model calls per answer (each tool round is one call). */
    maxToolRounds: int("AI_CFO_MAX_TOOL_ROUNDS", 8, 1, 16),
    /** Characters in one user message. */
    maxMessageChars: int("AI_CFO_MAX_MESSAGE_CHARS", 4000, 200, 20000),
    /** Earlier messages of the conversation sent back to the model. */
    historyMessages: int("AI_CFO_HISTORY_MESSAGES", 20, 2, 60),
    /** Requests per user per minute and per day. */
    perMinute: int("AI_CFO_RATE_PER_MINUTE", 6, 1, 120),
    perDay: int("AI_CFO_RATE_PER_DAY", 150, 1, 10000),
    /** Estimated spend caps in USD: per user per day, per organization per calendar month. 0 = AI off. */
    userDailyUsd: dollars("AI_CFO_USER_DAILY_BUDGET_USD", 10),
    orgMonthlyUsd: dollars("AI_CFO_MONTHLY_BUDGET_USD", 100),
    effort: (["low", "medium", "high", "xhigh", "max"] as const).find((e) => e === process.env.AI_CFO_EFFORT?.trim()) ?? "medium",
  }
}

export type AiLimits = ReturnType<typeof aiLimits>

/** USD per million tokens. Unknown models are priced as the most expensive known one (conservative). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
}
const MOST_EXPENSIVE = PRICES["claude-fable-5-1"]

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

/** Estimated cost in USD for token usage on a model (used for the spending limits; not an invoice). */
export function estimateCost(model: string, u: Usage) {
  const p = PRICES[model] ?? MOST_EXPENSIVE
  const cost = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}
