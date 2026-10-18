"use client"

import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Info, Lock } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { fill } from "@/lib/i18n/dictionaries"
import { monthName, type Locale } from "@/lib/i18n/format"
import type { SheetAdminTexts } from "@/lib/i18n/sheet-admin"
import { currentMonthKey, monthKeyOf, shiftMonth } from "@/lib/month-nav"

import { periodAction } from "./actions"

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [open, close])
  return ref
}

/** [←] [Октябрь 2026 ▼] [→] [Сегодня]: arrows, a month/year popover and a jump to the current month. */
export function MonthPicker({ monthKey, locale, t, onNavigate }: { monthKey: string; locale: Locale; t: SheetAdminTexts; onNavigate: (key: string) => void }) {
  const [y, m] = monthKey.split("-").map(Number)
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(y)
  const [today, setToday] = useState<string | null>(null)
  const ref = useDismiss(open, () => setOpen(false))
  const short = (month: number) => {
    const s = new Date(Date.UTC(2026, month - 1, 1)).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", { month: "short", timeZone: "UTC" }).replace(".", "")
    return s.charAt(0).toUpperCase() + s.slice(1)
  }
  const go = (key: string) => {
    setOpen(false)
    if (key !== monthKey) onNavigate(key)
  }
  const arrow = "flex size-9 items-center justify-center rounded-full border border-border hover:border-primary/60 hover:text-primary"
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" aria-label={locale === "ru" ? "Предыдущий месяц" : "Previous month"} onClick={() => go(shiftMonth(monthKey, -1))} className={arrow}>
        <ChevronLeft className="size-4" />
      </button>
      <div ref={ref} className="relative">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t.month.choose}
          onClick={() => {
            setYear(y)
            setToday(currentMonthKey())
            setOpen((v) => !v)
          }}
          className="flex items-center gap-2 rounded-xl px-2 py-1 hover:bg-primary/10"
        >
          <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{monthName(y, m, locale)}</h1>
          <ChevronDown className={cn("size-5 text-primary transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div role="dialog" aria-label={t.month.choose} className="absolute top-full left-0 z-50 mt-2 w-72 rounded-2xl border border-primary/30 bg-[#110d12] p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <button type="button" aria-label={t.month.prevYear} onClick={() => setYear((v) => Math.max(2000, v - 1))} className="rounded-lg p-1.5 hover:bg-primary/10 hover:text-primary"><ChevronLeft className="size-4" /></button>
              <select aria-label={locale === "ru" ? "Год" : "Year"} value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded-lg border border-border bg-transparent px-2 py-1 font-display text-lg font-black [color-scheme:dark]">
                {Array.from({ length: 21 }, (_, i) => y - 10 + i).filter((v) => v >= 2000 && v <= 2100).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <button type="button" aria-label={t.month.nextYear} onClick={() => setYear((v) => Math.min(2100, v + 1))} className="rounded-lg p-1.5 hover:bg-primary/10 hover:text-primary"><ChevronRight className="size-4" /></button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
                const key = monthKeyOf(year, month)
                return (
                  <button
                    key={month}
                    type="button"
                    onClick={() => go(key)}
                    aria-current={key === monthKey ? "date" : undefined}
                    className={cn(
                      "rounded-lg border px-2 py-2 text-sm",
                      key === monthKey ? "border-primary bg-primary text-primary-foreground" : key === today ? "border-primary/50 text-primary" : "border-border/60 hover:border-primary/50 hover:bg-primary/10",
                    )}
                  >
                    {short(month)}
                  </button>
                )
              })}
            </div>
            <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => go(currentMonthKey())}>
              <CalendarDays /> {t.month.current}
            </Button>
          </div>
        )}
      </div>
      <button type="button" aria-label={locale === "ru" ? "Следующий месяц" : "Next month"} onClick={() => go(shiftMonth(monthKey, 1))} className={arrow}>
        <ChevronRight className="size-4" />
      </button>
      <Button size="sm" variant="outline" onClick={() => go(currentMonthKey())}>{t.month.today}</Button>
    </div>
  )
}

type Period = { status: "OPEN" | "CLOSING" | "CLOSED" | "LOCKED"; closedAt: string | null; closedBy: string | null; draftEntries: number }
type Run = "draft" | "approved" | "paying" | "paid" | "readOnly"

/** Payroll status and period status as compact badges with explanations and the period actions. */
export function StatusBadges(props: {
  monthKey: string
  monthTitle: string
  period: Period
  run: Run
  can: { close: boolean; reopen: boolean }
  t: SheetAdminTexts
  onChanged: (message: string, tone?: "ok" | "error") => void
}) {
  const P = props.t.period
  const [open, setOpen] = useState<null | "run" | "period">(null)
  const [busy, setBusy] = useState(false)
  const ref = useDismiss(open !== null, () => setOpen(null))
  const status = P.status[props.period.status]
  const run = P.run[props.run]
  const closed = props.period.status === "CLOSED" || props.period.status === "LOCKED"

  async function act(action: "review" | "close" | "reopen") {
    let reason: string | null = null
    if (action === "reopen") {
      reason = window.prompt(fill(P.reopenPrompt, { month: props.monthTitle }))
      if (!reason) return
    } else if (!window.confirm(fill(action === "close" ? P.closeConfirm : P.reviewConfirm, { month: props.monthTitle }))) return
    setBusy(true)
    const r = await periodAction(props.monthKey, action, reason)
    setBusy(false)
    setOpen(null)
    props.onChanged(r.ok ? P.done : r.message, r.ok ? "ok" : "error")
  }

  const pill = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs"
  return (
    <div ref={ref} className="relative flex flex-wrap items-center gap-2">
      <button type="button" title={run.tip} aria-expanded={open === "run"} onClick={() => setOpen(open === "run" ? null : "run")} className={cn(pill, props.run === "draft" ? "border-border text-muted-foreground" : props.run === "readOnly" ? "border-amber-400/40 text-amber-300" : "border-primary/50 text-primary")}>
        <span className="text-[10px] uppercase tracking-wider opacity-70">{P.payroll}</span> {run.name} <Info className="size-3" />
      </button>
      <button type="button" title={status.tip} aria-expanded={open === "period"} onClick={() => setOpen(open === "period" ? null : "period")} className={cn(pill, closed ? "border-red-400/50 text-red-300" : props.period.status === "CLOSING" ? "border-amber-400/50 text-amber-300" : "border-emerald-400/40 text-emerald-300")}>
        {closed && <Lock className="size-3" />}
        <span className="text-[10px] uppercase tracking-wider opacity-70">{P.label}</span> {status.name} <Info className="size-3" />
      </button>
      {open && (
        <div role="dialog" className="absolute top-full left-0 z-50 mt-2 w-80 rounded-2xl border border-primary/30 bg-[#110d12] p-4 text-sm shadow-2xl">
          {open === "run" ? (
            <p><span className="font-semibold">{run.name}</span> — {run.tip.replace(/^[^—:]+[—:]\s*/, "")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p><span className="font-semibold">{status.name}</span> — {status.tip.replace(/^[^:]+:\s*/, "")}</p>
              {props.period.closedAt && props.period.status !== "OPEN" && <p className="text-xs text-muted-foreground">{fill(P.closedBy, { date: props.period.closedAt.slice(0, 10), who: props.period.closedBy ?? "—" })}</p>}
              {props.period.draftEntries > 0 && !closed && <p className="text-xs text-amber-300">{fill(P.drafts, { n: props.period.draftEntries })}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {props.can.close && props.period.status === "OPEN" && <Button size="sm" variant="outline" disabled={busy} onClick={() => act("review")}>{P.review}</Button>}
                {props.can.close && (props.period.status === "OPEN" || props.period.status === "CLOSING") && <Button size="sm" disabled={busy || props.period.draftEntries > 0} onClick={() => act("close")}><Lock /> {P.close}</Button>}
                {props.can.reopen && (props.period.status === "CLOSING" || props.period.status === "CLOSED") && <Button size="sm" variant="outline" disabled={busy} onClick={() => act("reopen")}>{P.reopen}</Button>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
