import { NextResponse, type NextRequest } from "next/server"

import { getSession } from "@/lib/auth/session"
import { runChat, ChatRequestSchema, type ChatEvent } from "@/lib/ai/chat"
import { aiConfigured } from "@/lib/ai/config"
import { callClaude } from "@/lib/ai/provider"

/*
 * AI CFO chat endpoint. Signed-in users with reports:read only; the request is validated strictly
 * and the answer is streamed as newline-delimited JSON events. The provider key stays on the server.
 */

export const maxDuration = 300

const MAX_BODY_BYTES = 64 * 1024

function sameOrigin(origin: string | null, host: string) {
  if (!origin) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const json = (status: number, code: string) => NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } })

export async function POST(request: NextRequest) {
  // Same-origin only (the session cookie is also SameSite=Lax).
  if (!sameOrigin(request.headers.get("origin"), request.nextUrl.host)) return json(403, "forbidden")
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json(415, "unsupported_media_type")

  const session = await getSession()
  if (session.state !== "ok") return json(401, "unauthorized")
  const user = session.user
  if (!user.permissions.has("reports:read")) return json(403, "forbidden")
  if (!aiConfigured()) return json(503, "not_configured")

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json(413, "too_large")
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, "invalid_request")
  }
  const parsed = ChatRequestSchema.safeParse(body)
  if (!parsed.success) return json(400, "invalid_request")

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const emit = (e: ChatEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`))
        } catch {
          // The browser went away; the answer still completes so its usage is recorded.
          open = false
        }
      }
      try {
        await runChat(user, parsed.data, emit, { callModel: callClaude })
      } catch (err) {
        console.error("AI CFO: chat failed", err instanceof Error ? err.message : err)
        emit({ type: "error", code: "internal" })
      } finally {
        if (open) controller.close()
      }
    },
  })
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })
}
