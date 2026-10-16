import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"

/*
 * The only place that talks to the AI provider. Server-side only: the SDK reads ANTHROPIC_API_KEY
 * from the server environment; the key never reaches the browser, the database or the logs.
 */

export type ModelCall = (params: BetaMessageStreamParams, onText: (delta: string) => void) => Promise<BetaMessage>

let client: Anthropic | null = null

/** Streams one model call, forwarding text deltas, and resolves with the complete message. */
export const callClaude: ModelCall = async (params, onText) => {
  client ??= new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 })
  const stream = client.beta.messages.stream(params)
  stream.on("text", onText)
  return stream.finalMessage()
}

/** Server-side fallback on a policy decline (picked by Anthropic per refusal category). */
export const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }

export { Anthropic }
