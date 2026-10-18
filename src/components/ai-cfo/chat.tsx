"use client"

import { ArrowUp, Calculator, ChevronRight, ExternalLink, FileText, Loader2, MessageSquarePlus, Paperclip, Square, Trash2, TriangleAlert } from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

import { archiveConversationAction, loadConversationAction } from "@/app/(app)/ai-cfo/actions"
import { Select, Textarea } from "@/components/ui/form-controls"
import type { ChatEvent, StopReason, ToolEvent } from "@/lib/ai/chat"
import type { DataGap, SourceRef } from "@/lib/ai/envelope"
import { aiTexts, type AiTexts } from "@/lib/i18n/ai-cfo"
import { useI18n } from "@/lib/i18n/client"

import { ASK_EVENT } from "./insight-actions"
import { Markdown } from "./markdown"
import { streamChat } from "./stream"

type Msg = {
  id: string
  role: "USER" | "ASSISTANT"
  content: string
  tools: ToolEvent[]
  followUps: string[]
  status: "STREAMING" | "COMPLETE" | "TRUNCATED" | "REFUSED" | "ERROR"
  reason?: StopReason
  error?: string
}

type Conversation = { id: string; title: string; updatedAt: string }

const FOCUS = ["general", "pnl", "cash", "costs", "payroll", "departments", "clients", "budget", "owners", "forecast"] as const
const ATTACHMENTS = ["pnl", "cash_flow", "balance_sheet", "budget_variance", "departments", "expenses"] as const

const visible = (text: string) => text.split("<follow-ups>")[0]

function dedupeSources(tools: ToolEvent[]) {
  const seen = new Set<string>()
  const out: SourceRef[] = []
  for (const t of tools) for (const s of t.sources ?? []) {
    const k = `${s.href}|${s.label}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push(s)
    }
  }
  return out
}

const periodText = (p: ToolEvent["period"]) => (!p ? "" : "key" in p ? p.key.replace("..", " – ") : p.asOf)

/** Localized source label: report names are translated, records (accounts, clients, departments) keep their names. */
function sourceLabel(s: SourceRef, t: AiTexts) {
  if (t.sourceLabel[s.label]) return t.sourceLabel[s.label]
  const m = /^(Budget|Monthly analytics) (\d{4})(.*)$/.exec(s.label)
  if (m && Object.keys(t.sourceLabel).length) return `${m[1] === "Budget" ? "Бюджет" : "Аналитика"} ${m[2]}${m[3]}`
  return s.label
}

function gapsOf(tools: ToolEvent[]) {
  const seen = new Set<string>()
  const out: DataGap[] = []
  for (const tool of tools) for (const g of tool.completeness?.gaps ?? []) {
    const k = `${g.code}|${g.href ?? ""}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push(g)
    }
  }
  return out
}

/** While the answer is being prepared: which records are being looked at, in business words. */
function Progress({ tools, t }: { tools: ToolEvent[]; t: AiTexts }) {
  const shown = tools.filter((x) => !x.attachment || x.status === "running")
  if (!shown.length) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t.chat.thinking}</p>
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-primary" />
      {t.working}:
      {shown.map((x) => (
        <span key={x.id} className={cn(x.status === "running" ? "text-foreground" : "opacity-70")}>
          {t.calc[x.name] ?? t.chat.tools}
          {periodText(x.period) && ` (${periodText(x.period)})`}
        </span>
      ))}
    </p>
  )
}

/** Data the answer needed but the books do not have yet, with links to where it is entered. */
function MissingData({ tools, t }: { tools: ToolEvent[]; t: AiTexts }) {
  const actionable = gapsOf(tools).filter((g) => g.href && t.gap[g.code]?.link)
  if (!actionable.length) return null
  return (
    <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/5 p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300"><TriangleAlert className="size-3.5" /> {t.missingTitle}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {actionable.map((g) => (
          <li key={`${g.code}|${g.href}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-foreground/90">{t.gap[g.code].text}</span>
            <Link href={g.href!} className="text-primary underline-offset-4 hover:underline">{t.gap[g.code].link} →</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Sources, calculations and technical details, collapsed by default. */
function Details({ tools, t }: { tools: ToolEvent[]; t: AiTexts }) {
  const calcs = tools.filter((x) => x.status !== "running")
  if (!calcs.length) return null
  const sources = dedupeSources(calcs)
  const notes = gapsOf(calcs).filter((g) => !(g.href && t.gap[g.code]?.link))
  return (
    <details className="group mt-3 rounded-xl border border-border/60 bg-background/40 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        {t.details} ({calcs.length})
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-border/40 px-3 py-2.5">
        <ul className="flex flex-col gap-0.5">
          {calcs.map((x) => (
            <li key={x.id} className="flex items-center gap-1.5 text-muted-foreground">
              {x.status === "error" ? <TriangleAlert className="size-3 text-red-300" /> : x.attachment ? <Paperclip className="size-3" /> : <Calculator className="size-3" />}
              <span className="text-foreground/80">{t.calc[x.name] ?? x.name}</span>
              {periodText(x.period) && <span>· {periodText(x.period)}</span>}
              {x.nature === "forecast" && <span className="text-amber-300">· {t.chat.forecast}</span>}
              {x.status === "error" && <span className="text-red-300">· {t.chat.failed}</span>}
            </li>
          ))}
        </ul>
        {sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {sources.slice(0, 16).map((s) => (
              <Link key={`${s.href}|${s.label}`} href={s.href} className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/60 hover:text-primary">
                {sourceLabel(s, t)}
                <ExternalLink className="size-3" />
              </Link>
            ))}
          </div>
        )}
        {notes.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-amber-200/80">
            {notes.map((g) => <li key={g.code}>{t.gap[g.code]?.text ?? g.note}</li>)}
          </ul>
        )}
        <details className="text-[11px] text-muted-foreground/70">
          <summary className="cursor-pointer list-none hover:text-muted-foreground">{t.technical}</summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {calcs.map((x) => <li key={x.id}>{x.name} {JSON.stringify(x.input ?? {})} → {x.status}{x.completeness ? ` (${x.completeness.status})` : ""}{x.error ? `: ${x.error}` : ""}</li>)}
          </ul>
        </details>
      </div>
    </details>
  )
}

function MessageView({ m, t, onAsk, busy }: { m: Msg; t: AiTexts; onAsk: (q: string) => void; busy: boolean }) {
  if (m.role === "USER") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary/15 px-4 py-2.5 text-sm">{m.content}</div>
      </div>
    )
  }
  const text = visible(m.content)
  const notice = m.status === "TRUNCATED" && m.reason && m.reason in t.status.TRUNCATED ? t.status.TRUNCATED[m.reason as keyof AiTexts["status"]["TRUNCATED"]] : m.status === "REFUSED" ? t.status.REFUSED : m.status === "ERROR" ? (m.error ?? t.status.ERROR) : null
  return (
    <div className="flex flex-col rounded-2xl border border-border/60 bg-card/60 p-4">
      {m.status === "STREAMING" && <div className="mb-2"><Progress tools={m.tools} t={t} /></div>}
      {text && <Markdown text={text} />}
      {notice && <p className="mt-2 flex items-center gap-2 text-xs text-amber-300"><TriangleAlert className="size-3.5" /> {notice}</p>}
      {m.status !== "STREAMING" && <MissingData tools={m.tools} t={t} />}
      {m.status !== "STREAMING" && <Details tools={m.tools} t={t} />}
      {m.followUps.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.chat.followUps}</p>
          <div className="flex flex-wrap gap-1.5">
            {m.followUps.map((q) => (
              <button key={q} type="button" disabled={busy} onClick={() => onAsk(q)} className="rounded-full border border-primary/30 px-3 py-1 text-left text-xs text-primary hover:bg-primary/10 disabled:opacity-50">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AiChat(props: {
  configured: boolean
  period: string
  departments: { id: string; name: string }[]
  initialConversations: Conversation[]
  /** No posted records yet: show getting-started prompts. */
  empty?: boolean
}) {
  const { locale } = useI18n()
  const t = aiTexts[locale]
  const [conversations, setConversations] = useState(props.initialConversations)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState("")
  const [departmentId, setDepartmentId] = useState("")
  const [focus, setFocus] = useState<(typeof FOCUS)[number]>("general")
  const [attachments, setAttachments] = useState<(typeof ATTACHMENTS)[number][]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const roundStart = useRef(0)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [messages])

  // Questions sent from the insights and targets panels on the same page.
  const sendRef = useRef<(q: string) => void>(() => {})
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    const onAsk = (e: Event) => {
      section.current?.scrollIntoView({ block: "start", behavior: "smooth" })
      sendRef.current((e as CustomEvent<string>).detail)
    }
    window.addEventListener(ASK_EVENT, onAsk)
    return () => window.removeEventListener(ASK_EVENT, onAsk)
  }, [])

  const updateLast = (fn: (m: Msg) => Msg) => setMessages((list) => list.map((m, i) => (i === list.length - 1 ? fn(m) : m)))

  const errorText = (code: string) => (t.errors as Record<string, string>)[code] ?? t.errors.internal

  async function send(text: string) {
    const question = text.trim()
    if (!question || busy || !props.configured) return
    setError(null)
    setInput("")
    setBusy(true)
    const userMsg: Msg = { id: `u${messages.length}`, role: "USER", content: question, tools: [], followUps: [], status: "COMPLETE" }
    const answer: Msg = { id: `a${messages.length}`, role: "ASSISTANT", content: "", tools: [], followUps: [], status: "STREAMING" }
    setMessages((list) => [...list, userMsg, answer])
    const controller = new AbortController()
    abort.current = controller
    const sentAttachments = attachments
    setAttachments([])
    try {
      const res = await streamChat(
        { conversationId: activeId, message: question, locale, period: props.period, departmentId: departmentId || null, focus, attachments: sentAttachments },
        controller.signal,
        handle,
      )
      if (!res.ok) updateLast((m) => ({ ...m, status: "ERROR", error: errorText(res.code) }))
    } catch (e) {
      if ((e as Error).name !== "AbortError") updateLast((m) => ({ ...m, status: "ERROR", error: t.errors.network }))
      else updateLast((m) => ({ ...m, status: m.status === "STREAMING" ? "TRUNCATED" : m.status }))
    } finally {
      setBusy(false)
      abort.current = null
      updateLast((m) => (m.status === "STREAMING" ? { ...m, status: "ERROR" } : m))
    }
  }

  function handle(e: ChatEvent) {
    switch (e.type) {
      case "conversation":
        setActiveId(e.id)
        setConversations((list) => [{ id: e.id, title: e.title, updatedAt: "" }, ...list.filter((c) => c.id !== e.id)])
        break
      case "round":
        setMessages((list) => {
          roundStart.current = list[list.length - 1]?.content.length ?? 0
          return list
        })
        break
      case "retry":
        updateLast((m) => ({ ...m, content: m.content.slice(0, roundStart.current) }))
        break
      case "text":
        updateLast((m) => ({ ...m, content: m.content + e.delta }))
        break
      case "tool":
        updateLast((m) => ({ ...m, tools: m.tools.some((x) => x.id === e.tool.id) ? m.tools.map((x) => (x.id === e.tool.id ? e.tool : x)) : [...m.tools, e.tool] }))
        break
      case "done":
        updateLast((m) => ({ ...m, id: e.messageId, content: e.status === "REFUSED" ? "" : visible(m.content).trim(), followUps: e.followUps, status: e.status, reason: e.reason }))
        break
      case "error":
        if (e.code === "provider_auth" || e.code === "provider_model" || e.code === "provider_bad_request" || e.code === "provider_rate_limited" || e.code === "provider_unavailable" || e.code === "internal") updateLast((m) => ({ ...m, error: errorText(e.code) }))
        else {
          updateLast((m) => ({ ...m, status: "ERROR", error: errorText(e.code) }))
          setError(errorText(e.code))
        }
        break
    }
  }

  useEffect(() => {
    sendRef.current = send
  })

  async function open(id: string) {
    if (busy) return
    const res = await loadConversationAction(id)
    if (!res.ok) return setError(res.message)
    setActiveId(id)
    const ctx = res.conversation.context
    if (ctx.departmentId && props.departments.some((d) => d.id === ctx.departmentId)) setDepartmentId(ctx.departmentId)
    if (ctx.focus && FOCUS.includes(ctx.focus as (typeof FOCUS)[number])) setFocus(ctx.focus as (typeof FOCUS)[number])
    setMessages(res.conversation.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, tools: m.tools, followUps: m.followUps, status: m.status })))
  }

  function newChat() {
    if (busy) return
    setActiveId(null)
    setMessages([])
    setError(null)
  }

  async function archive(id: string) {
    const res = await archiveConversationAction(id)
    if (!res.ok) return setError(res.message)
    setConversations((list) => list.filter((c) => c.id !== id))
    if (activeId === id) newChat()
  }

  const toggleAttachment = (a: (typeof ATTACHMENTS)[number]) => setAttachments((list) => (list.includes(a) ? list.filter((x) => x !== a) : list.length >= 3 ? list : [...list, a]))

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-2 lg:max-h-[75vh]">
        <button type="button" onClick={newChat} disabled={busy} className="flex items-center justify-center gap-2 rounded-xl border border-primary/40 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50">
          <MessageSquarePlus className="size-4" /> {t.chat.newChat}
        </button>
        <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.chat.conversations}</p>
        <div className="flex flex-col gap-1 overflow-y-auto">
          {conversations.length === 0 && <p className="text-xs text-muted-foreground">{t.chat.noConversations}</p>}
          {conversations.map((c) => (
            <div key={c.id} className={cn("group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm", c.id === activeId ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted/40")}>
              <button type="button" onClick={() => open(c.id)} className="min-w-0 flex-1 truncate text-left">{c.title}</button>
              <button type="button" onClick={() => archive(c.id)} aria-label={t.chat.archive} title={t.chat.archive} className="opacity-0 hover:text-red-300 group-hover:opacity-100 focus:opacity-100">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section ref={section} className="flex min-h-[60vh] scroll-mt-20 flex-col rounded-2xl border border-border bg-card/30">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.chat.context}</span>
          <span className="rounded-full border border-border px-2.5 py-0.5 font-mono text-xs">{props.period}</span>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-7 w-48 text-xs" aria-label={t.chat.department}>
            <option value="">{t.chat.allDepartments}</option>
            {props.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Select value={focus} onChange={(e) => setFocus(e.target.value as (typeof FOCUS)[number])} className="h-7 w-36 text-xs" aria-label={t.chat.focus}>
            {FOCUS.map((f) => <option key={f} value={f}>{t.chat.focus}: {t.focus[f]}</option>)}
          </Select>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 lg:max-h-[60vh]">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
              <p className="font-display text-xl font-black uppercase italic">{t.chat.welcome}</p>
              <div className="grid w-full max-w-3xl gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(props.empty ? t.emptyPrompts : t.prompts).map((p) => (
                  <button key={p} type="button" disabled={!props.configured || busy} onClick={() => send(p)} className="rounded-xl border border-border bg-card/60 px-4 py-3 text-left text-sm hover:border-primary/60 hover:text-primary disabled:opacity-50">
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <MessageView key={m.id} m={m} t={t} onAsk={send} busy={busy || !props.configured} />)
          )}
          <div ref={bottom} />
        </div>

        <div className="border-t border-border/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5" title={t.chat.attachHint}>
            <FileText className="size-3.5 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">{t.chat.attach}:</span>
            {ATTACHMENTS.map((a) => (
              <button key={a} type="button" aria-pressed={attachments.includes(a)} onClick={() => toggleAttachment(a)} className={cn("rounded-full border px-2 py-0.5 text-[11px]", attachments.includes(a) ? "border-primary/60 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
                {t.attachments[a]}
              </button>
            ))}
          </div>
          {error && <p className="mb-2 text-xs text-red-300">{error}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
            className="flex items-end gap-2"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send(input)
                }
              }}
              maxLength={4000}
              rows={2}
              disabled={!props.configured}
              placeholder={props.configured ? t.chat.placeholder : t.notConfigured}
              aria-label={t.chat.placeholder}
              className="min-h-12 resize-none"
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()} aria-label={t.chat.stop} className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border hover:border-red-400/60">
                <Square className="size-4" />
              </button>
            ) : (
              <button type="submit" disabled={!props.configured || !input.trim()} aria-label={t.chat.send} className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-40">
                <ArrowUp className="size-4" />
              </button>
            )}
          </form>
          <p className="mt-2 text-[11px] text-muted-foreground">{t.chat.readOnly}</p>
        </div>
      </section>
    </div>
  )
}
