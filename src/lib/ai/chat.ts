import "server-only"

import type { BetaContentBlockParam, BetaMessageParam, BetaTextBlockParam, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { z } from "zod"

import type { Prisma } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { UserInputError } from "@/lib/forms"
import { currentRange, parseRange } from "@/lib/reports/periods"

import { aiLimits, estimateCost, type AiLimits, type Usage } from "./config"
import type { Completeness, SourceRef, ToolEnvelope } from "./envelope"
import { checkLimits, remainingBudget, usageSnapshot, type LimitBlock } from "./limits"
import { contextPrompt, splitFollowUps, SYSTEM_PROMPT } from "./prompt"
import { Anthropic, FALLBACK, type ModelCall } from "./provider"
import { assertDepartment } from "./queries"
import { FINANCIAL_TOOLS, runTool, ToolDenied, toolInputSchema, toolsFor } from "./tools"

/*
 * AI CFO chat: one user question -> a streamed answer. The model may call the read-only financial
 * tools in a loop; each call is permission-checked, validated, audited and its sources passed to the
 * user interface. History, usage and estimated cost are stored per message for the limits.
 */

// ─── Request ─────────────────────────────────────────────────────────────────

export const FOCUS = ["general", "pnl", "cash", "costs", "payroll", "departments", "clients", "budget", "owners", "forecast"] as const
export const ATTACHMENTS = {
  pnl: "getProfitAndLoss",
  cash_flow: "getCashFlow",
  balance_sheet: "getBalanceSheet",
  budget_variance: "getBudgetVariance",
  departments: "getDepartmentProfitability",
  expenses: "getExpensesByCategory",
} as const

export const ChatRequestSchema = z.strictObject({
  conversationId: z.uuid().nullish(),
  message: z.string().trim().min(1),
  locale: z.enum(["ru", "en"]).default("ru"),
  period: z
    .string()
    .regex(/^(20\d{2}|2100)(-(0[1-9]|1[0-2])|-Q[1-4])?$/)
    .nullish(),
  departmentId: z.uuid().nullish(),
  focus: z.enum(FOCUS).nullish(),
  attachments: z.array(z.enum(Object.keys(ATTACHMENTS) as [keyof typeof ATTACHMENTS, ...(keyof typeof ATTACHMENTS)[]])).max(3).default([]),
})
export type ChatRequest = z.infer<typeof ChatRequestSchema>

// ─── Events streamed to the browser ──────────────────────────────────────────

export type ToolEvent = {
  id: string
  name: string
  input: unknown
  status: "running" | "done" | "error"
  attachment?: boolean
  period?: ToolEnvelope<unknown>["period"]
  nature?: ToolEnvelope<unknown>["nature"]
  completeness?: Pick<Completeness, "status" | "notes">
  sources?: SourceRef[]
  error?: string
}

export type StopReason = "complete" | "refusal" | "max_tokens" | "tool_rounds" | "budget" | "provider_error"

export type ChatEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "round" }
  | { type: "retry" }
  | { type: "text"; delta: string }
  | { type: "tool"; tool: ToolEvent }
  | { type: "done"; messageId: string; status: "COMPLETE" | "TRUNCATED" | "REFUSED" | "ERROR"; reason: StopReason; followUps: string[]; usage: Usage & { costUsd: number; model: string } }
  | { type: "error"; code: LimitBlock["code"] | "invalid_request" | "not_found" | "provider_auth" | "provider_rate_limited" | "provider_unavailable" | "internal"; message?: string; retryAfterSeconds?: number | null }

export type ChatDeps = { callModel: ModelCall; db?: Db; limits?: AiLimits; now?: () => Date }

const MAX_TOOL_RESULT_CHARS = 60_000

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

async function auditAi(db: Db, user: SessionUser, action: string, conversationId: string | null, after: Prisma.InputJsonValue) {
  await db.auditLog.create({ data: { organizationId: user.organizationId, actorType: "USER", actorUserId: user.id, action, entityType: "ai_conversation", entityId: conversationId, after } })
}

function toolResultContent(envelope: unknown) {
  const json = JSON.stringify(envelope)
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json
  return JSON.stringify({ truncated: true, note: `Result was ${json.length} characters; only the first ${MAX_TOOL_RESULT_CHARS} are included. Ask for a narrower period or filter.`, partial: json.slice(0, MAX_TOOL_RESULT_CHARS) })
}

/** One line naming the calculations an earlier answer used (tool and input only, never results). */
export function toolsNote(tools: unknown) {
  if (!Array.isArray(tools)) return ""
  const calls = (tools as { name?: unknown; input?: unknown; status?: unknown }[])
    .filter((t) => typeof t.name === "string" && t.status === "done")
    .map((t) => `${t.name}(${JSON.stringify(t.input ?? {}).slice(0, 120)})`)
  return calls.length ? `\n\n[Calculations used for this answer: ${calls.slice(0, 12).join(", ")}]` : ""
}

/** Text-only history in strict user/assistant alternation, starting with the user. */
export function historyMessages(rows: { role: "USER" | "ASSISTANT"; content: string; status: string; tools?: unknown }[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = []
  for (const r of rows) {
    if (r.role === "ASSISTANT" && (r.status === "ERROR" || r.status === "REFUSED" || !r.content.trim())) continue
    const role = r.role === "USER" ? "user" : "assistant"
    const content = role === "assistant" ? r.content + toolsNote(r.tools) : r.content
    const last = out[out.length - 1]
    if (last && last.role === role) last.content = `${last.content as string}\n\n${content}`
    else if (out.length || role === "user") out.push({ role, content })
  }
  if (out.length && out[out.length - 1].role === "user") out.pop() // unanswered question: the new one replaces it
  return out
}

/** Messages for one call, with a single cache breakpoint on the last block (conversation prefix reuse). */
function withCacheBreakpoint(messages: BetaMessageParam[]): BetaMessageParam[] {
  return messages.map((m, i) => {
    if (i !== messages.length - 1 || typeof m.content === "string") return m
    const blocks = m.content.map((b, j) => (j === m.content.length - 1 ? ({ ...b, cache_control: { type: "ephemeral" } } as BetaContentBlockParam) : b))
    return { ...m, content: blocks }
  })
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function runChat(user: SessionUser, request: ChatRequest, emit: (e: ChatEvent) => void, deps: ChatDeps) {
  const db = deps.db ?? prisma
  const limits = deps.limits ?? aiLimits()
  const now = deps.now ?? (() => new Date())
  if (request.message.length > limits.maxMessageChars) {
    emit({ type: "error", code: "invalid_request", message: `Message is longer than ${limits.maxMessageChars} characters.` })
    return
  }

  const usageBefore = await usageSnapshot(user, db, now())
  const blocked = checkLimits(limits, usageBefore)
  if (blocked) {
    await auditAi(db, user, "ai_cfo.limit", request.conversationId ?? null, { code: blocked.code })
    emit({ type: "error", code: blocked.code, retryAfterSeconds: blocked.retryAfterSeconds })
    return
  }

  let department: { id: string; name: string } | null
  try {
    department = await assertDepartment(user, request.departmentId, db)
  } catch (e) {
    emit({ type: "error", code: "not_found", message: e instanceof Error ? e.message : undefined })
    return
  }

  // Conversation: the user's own, active one, or a new one.
  let conversation = request.conversationId
    ? await db.aiConversation.findFirst({ where: { id: request.conversationId, organizationId: user.organizationId, userId: user.id, archivedAt: null } })
    : null
  if (request.conversationId && !conversation) {
    emit({ type: "error", code: "not_found", message: "Conversation not found." })
    return
  }
  const context = { period: request.period ?? null, departmentId: department?.id ?? null, focus: request.focus ?? null }
  if (!conversation) {
    const title = request.message.replace(/\s+/g, " ").slice(0, 80)
    conversation = await db.aiConversation.create({ data: { organizationId: user.organizationId, userId: user.id, title, locale: request.locale, context } })
  } else {
    await db.aiConversation.update({ where: { id: conversation.id }, data: { context, locale: request.locale } })
  }
  emit({ type: "conversation", id: conversation.id, title: conversation.title })

  const previousRows = await db.aiMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: limits.historyMessages,
    select: { role: true, content: true, status: true, tools: true },
  })
  const history = historyMessages(previousRows.reverse())
  await db.aiMessage.create({ data: { conversationId: conversation.id, organizationId: user.organizationId, userId: user.id, role: "USER", content: request.message } })

  const toolLog: ToolEvent[] = []
  const r = parseRange(request.period ?? null, currentRange("month"))

  // Attached internal reports: run the tool server-side and include its result as data.
  const attachmentBlocks: BetaTextBlockParam[] = []
  for (const a of request.attachments) {
    const name = ATTACHMENTS[a]
    const input = name === "getBalanceSheet" ? {} : name === "getDepartmentProfitability" ? { period: r.key } : { period: r.key, ...(department ? { department_id: department.id } : {}) }
    const event = await executeTool(user, db, conversation.id, `att_${a}`, name, input, emit, toolLog, true)
    if (event.ok) attachmentBlocks.push({ type: "text", text: `<attached_report name="${a}">\n${event.content}\n</attached_report>` })
  }

  const allowed = toolsFor(user)
  const tools: BetaToolUnion[] = allowed.map((t) => ({ name: t.name, description: t.description, input_schema: toolInputSchema(t), eager_input_streaming: true }))
  const system: BetaTextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: contextPrompt({
        today: now().toISOString().slice(0, 10),
        organizationName: user.organizationName,
        baseCurrency: user.baseCurrency,
        locale: request.locale,
        role: describeAccess(user),
        period: request.period ?? null,
        department: department ? `${department.name} (department_id ${department.id})` : null,
        focus: request.focus ?? null,
        tools: allowed.map((t) => t.name),
        unavailable: FINANCIAL_TOOLS.filter((t) => !allowed.includes(t)).map((t) => `${t.name} (needs ${t.permission})`),
      }),
    },
  ]
  const userContent: BetaContentBlockParam[] = [...attachmentBlocks, { type: "text", text: request.message }]
  const messages: BetaMessageParam[] = [...history, { role: "user", content: userContent }]

  const usage = zeroUsage()
  let cost = 0
  let model = limits.model
  let text = ""
  let reason: StopReason = "complete"
  const budget = remainingBudget(limits, usageBefore)

  try {
    for (let round = 0; ; round++) {
      if (round >= limits.maxToolRounds) {
        reason = "tool_rounds"
        break
      }
      emit({ type: "round" })
      let roundText = ""
      let message
      for (let attempt = 0; ; attempt++) {
        try {
          message = await deps.callModel(
            {
              model: limits.model,
              max_tokens: limits.maxOutputTokens,
              system,
              tools,
              messages: withCacheBreakpoint(messages),
              thinking: { type: "adaptive" },
              output_config: { effort: limits.effort },
              ...FALLBACK,
            },
            (delta) => {
              roundText += delta
              emit({ type: "text", delta })
            },
          )
          break
        } catch (err) {
          // Only a tool input that could not be parsed is retried; API errors go to the outer handler.
          if (err instanceof Anthropic.APIError || attempt >= 2) throw err
          roundText = ""
          emit({ type: "retry" })
        }
      }
      model = message.model
      const u = message.usage
      const roundUsage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 }
      usage.inputTokens += roundUsage.inputTokens
      usage.outputTokens += roundUsage.outputTokens
      usage.cacheReadTokens += roundUsage.cacheReadTokens
      usage.cacheWriteTokens += roundUsage.cacheWriteTokens
      cost += estimateCost(message.model, roundUsage)
      text += roundText

      if (message.stop_reason === "refusal") {
        // A refusal can cut an answer (or a tool input) off: never use that partial output.
        reason = "refusal"
        text = ""
        break
      }
      const toolUses = message.content.filter((b) => b.type === "tool_use")
      if (message.stop_reason === "max_tokens") {
        reason = "max_tokens"
        break
      }
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content as BetaContentBlockParam[] })
        continue
      }
      if (toolUses.length === 0) break
      if (cost >= budget) {
        reason = "budget"
        break
      }

      messages.push({ role: "assistant", content: message.content as BetaContentBlockParam[] })
      const results: BetaToolResultBlockParam[] = []
      for (const call of toolUses) {
        const out = await executeTool(user, db, conversation.id, call.id, call.name, call.input, emit, toolLog, false)
        results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.ok ? {} : { is_error: true }) })
      }
      messages.push({ role: "user", content: results })
      if (text && !text.endsWith("\n")) text += "\n\n"
    }
  } catch (err) {
    reason = "provider_error"
    const code =
      err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
        ? "provider_auth"
        : err instanceof Anthropic.RateLimitError
          ? "provider_rate_limited"
          : err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError
            ? "provider_unavailable"
            : "internal"
    console.error("AI CFO: model call failed", code, err instanceof Anthropic.APIError ? err.status : err instanceof Error ? err.name : "")
    emit({ type: "error", code })
  }

  const { text: visible, followUps } = splitFollowUps(text)
  const status = reason === "complete" ? "COMPLETE" : reason === "refusal" ? "REFUSED" : reason === "provider_error" ? "ERROR" : "TRUNCATED"
  const costUsd = Math.round(cost * 1_000_000) / 1_000_000
  const saved = await db.aiMessage.create({
    data: {
      conversationId: conversation.id,
      organizationId: user.organizationId,
      userId: user.id,
      role: "ASSISTANT",
      status,
      content: visible,
      tools: toolLog as unknown as Prisma.InputJsonValue,
      followUps,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: costUsd.toFixed(6),
    },
  })
  await db.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: now() } })
  await auditAi(db, user, "ai_cfo.answer", conversation.id, { messageId: saved.id, status, reason, model, tools: toolLog.map((t) => t.name), ...usage, costUsd })
  emit({ type: "done", messageId: saved.id, status, reason, followUps, usage: { ...usage, costUsd, model } })
}

/** Runs one tool call for the model (or an attachment), audits it and reports it to the UI. */
async function executeTool(user: SessionUser, db: Db, conversationId: string, id: string, name: string, input: unknown, emit: (e: ChatEvent) => void, log: ToolEvent[], attachment: boolean) {
  const event: ToolEvent = { id, name, input, status: "running", attachment }
  emit({ type: "tool", tool: { ...event } })
  let content: string
  let ok = true
  try {
    const result = await runTool(user, name, input, db)
    Object.assign(event, { status: "done", period: result.period, nature: result.nature, completeness: { status: result.completeness.status, notes: result.completeness.notes }, sources: result.sources })
    content = toolResultContent(result)
  } catch (err) {
    ok = false
    const known = err instanceof UserInputError || err instanceof ToolDenied
    if (!known) console.error("AI CFO: tool failed", name, err instanceof Error ? err.message : err)
    const message = known ? (err as Error).message : "The tool failed with an internal error."
    Object.assign(event, { status: "error", error: message })
    content = JSON.stringify({ error: message })
  }
  log.push(event)
  emit({ type: "tool", tool: { ...event } })
  await auditAi(db, user, "ai_cfo.tool", conversationId, { tool: name, input: (input ?? {}) as Prisma.InputJsonValue, ok, attachment, error: event.error ?? null })
  return { ok, content }
}

function describeAccess(user: SessionUser) {
  const p = user.permissions
  const parts = [
    p.has("reports:read") && "financial reports",
    p.has("ledger:read") && "ledger source records",
    p.has("payroll:read") && "payroll totals",
    p.has("salary:read") && "individual salaries",
    p.has("ownership:read") && "ownership and distributions",
  ].filter(Boolean)
  return `${user.isSuperAdmin ? "Super Admin; " : ""}${parts.join(", ") || "none"}`
}
