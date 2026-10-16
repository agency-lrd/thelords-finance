"use client"

import { Download, Loader2, Sparkles } from "lucide-react"
import { useRef, useState } from "react"

import type { ToolEvent } from "@/lib/ai/chat"
import { aiTexts } from "@/lib/i18n/ai-cfo"
import { useI18n } from "@/lib/i18n/client"

import { Markdown } from "./markdown"
import { streamChat } from "./stream"

/** Prints the report; the browser's print dialog saves it as PDF (print styles hide the app chrome). */
export function PdfButton({ fileName }: { fileName: string }) {
  const { locale } = useI18n()
  const t = aiTexts[locale].reportPage
  return (
    <button
      type="button"
      data-print-hide
      title={t.pdfHint}
      onClick={() => {
        const previous = document.title
        document.title = fileName
        window.print()
        document.title = previous
      }}
      className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80"
    >
      <Download className="size-4" /> {t.exportPdf}
    </button>
  )
}

/** Optional AI commentary on the report, generated on request through the AI CFO chat endpoint. */
export function AiCommentary({ period, configured }: { period: string; configured: boolean }) {
  const { locale } = useI18n()
  const t = aiTexts[locale]
  const [text, setText] = useState("")
  const [tools, setTools] = useState<ToolEvent[]>([])
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const roundStart = useRef(0)
  const current = useRef("")

  async function generate() {
    setState("running")
    setText("")
    setTools([])
    setError(null)
    current.current = ""
    try {
      const res = await streamChat({ message: t.reportPage.aiPrompt.replace("{period}", period), locale, period, focus: "general" }, new AbortController().signal, (e) => {
        if (e.type === "round") roundStart.current = current.current.length
        else if (e.type === "retry") current.current = current.current.slice(0, roundStart.current)
        else if (e.type === "text") current.current += e.delta
        else if (e.type === "tool") setTools((list) => (list.some((x) => x.id === e.tool.id) ? list.map((x) => (x.id === e.tool.id ? e.tool : x)) : [...list, e.tool]))
        else if (e.type === "error") setError((t.errors as Record<string, string>)[e.code] ?? t.errors.internal)
        else if (e.type === "done" && e.status !== "COMPLETE") setError(e.status === "REFUSED" ? t.status.REFUSED : t.status.ERROR)
        setText(current.current.split("<follow-ups>")[0])
      })
      if (!res.ok) setError((t.errors as Record<string, string>)[res.code] ?? t.errors.internal)
      setState("done")
    } catch {
      setError(t.errors.network)
      setState("error")
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-primary/30 p-5 print:break-inside-avoid">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 font-display text-xl font-black uppercase italic"><Sparkles className="size-5 text-primary" /> {t.reportPage.aiCommentary}</h2>
        {state !== "running" && (
          <button type="button" data-print-hide disabled={!configured} onClick={generate} className="ml-auto rounded-xl border border-primary/40 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 disabled:opacity-40">
            {configured ? t.reportPage.aiGenerate : t.notConfigured}
          </button>
        )}
        {state === "running" && <Loader2 className="ml-auto size-4 animate-spin text-primary" />}
      </div>
      {(text || tools.length > 0) && <p className="text-[11px] text-muted-foreground">{t.reportPage.aiLabel}{tools.length > 0 && ` · ${tools.filter((x) => x.status === "done").length} ${t.chat.tools.toLowerCase()}`}</p>}
      {text && <Markdown text={text} />}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </section>
  )
}
