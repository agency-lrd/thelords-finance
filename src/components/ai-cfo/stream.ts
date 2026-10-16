import type { ChatEvent, ChatRequest } from "@/lib/ai/chat"

type Body = Omit<ChatRequest, "conversationId" | "attachments" | "locale"> & Partial<Pick<ChatRequest, "conversationId" | "attachments" | "locale">>

/**
 * Posts a question to the AI CFO endpoint and calls onEvent for each streamed event.
 * Resolves with an error code when the request was refused before streaming.
 */
export async function streamChat(body: Body, signal: AbortSignal, onEvent: (e: ChatEvent) => void): Promise<{ ok: true } | { ok: false; code: string }> {
  const res = await fetch("/api/ai-cfo/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return { ok: false, code: data.error ?? "internal" }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) onEvent(JSON.parse(line) as ChatEvent)
    }
  }
  return { ok: true }
}
