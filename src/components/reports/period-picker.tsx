"use client"

import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

import { useI18n } from "@/lib/i18n/client"
import { reportTexts } from "@/lib/i18n/reports"
import { parseRange, previous, range, rangeLabel, type PeriodKind, type Range } from "@/lib/reports/periods"

function next(r: Range): Range {
  if (r.kind === "year") return range("year", r.year + 1)
  const count = r.kind === "month" ? 12 : 4
  return r.index < count ? range(r.kind, r.year, r.index + 1) : range(r.kind, r.year + 1, 1)
}

const MONTHS = {
  ru: ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
}

/**
 * Month / quarter / year switch: previous/next arrows, a clickable label that opens a month (or
 * quarter) grid with a year selector, and a "current" shortcut. The period lives in the URL
 * (?p=2026-05, 2026-Q2, 2026; or another `param`), so it is bookmarkable and shared by all report pages.
 */
export function PeriodPicker({ value, kinds = ["month", "quarter", "year"], param = "p" }: { value: string; kinds?: PeriodKind[]; param?: string }) {
  const { locale } = useI18n()
  const t = reportTexts[locale]
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const now = new Date()
  const current = parseRange(value, range("month", now.getUTCFullYear(), now.getUTCMonth() + 1))
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState(current.year)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", esc)
    }
  }, [open])

  const go = (r: Range) => {
    const search = new URLSearchParams(params.toString())
    search.set(param, r.key)
    setOpen(false)
    router.push(`${pathname}?${search.toString()}`)
  }
  const switchKind = (kind: PeriodKind) => {
    const month = current.kind === "month" ? current.index : current.kind === "quarter" ? (current.index - 1) * 3 + 1 : 1
    go(kind === "month" ? range("month", current.year, month) : kind === "quarter" ? range("quarter", current.year, Math.ceil(month / 3)) : range("year", current.year))
  }
  const today = current.kind === "year" ? range("year", now.getUTCFullYear()) : current.kind === "quarter" ? range("quarter", now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) + 1) : range("month", now.getUTCFullYear(), now.getUTCMonth() + 1)
  const years = Array.from({ length: 9 }, (_, i) => now.getUTCFullYear() - 6 + i)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {kinds.length > 1 && (
        <div role="group" className="flex rounded-full border border-border p-0.5 text-sm">
          {kinds.map((k) => (
            <button key={k} type="button" aria-pressed={current.kind === k} onClick={() => switchKind(k)} className={cn("rounded-full px-3 py-1", current.kind === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {t.period[k]}
            </button>
          ))}
        </div>
      )}
      <button type="button" onClick={() => go(previous(current))} aria-label={t.period.prev} className="flex size-8 items-center justify-center rounded-full border border-border hover:border-primary/60 hover:text-primary">
        <ChevronLeft className="size-4" />
      </button>
      <div ref={box} className="relative">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setYear(current.year)
            setOpen((v) => !v)
          }}
          className="flex min-w-40 items-center justify-center gap-1.5 rounded-full px-3 py-1 font-display text-lg font-black uppercase italic hover:bg-white/5"
        >
          {rangeLabel(current, locale)} <ChevronDown className="size-4 not-italic opacity-60" />
        </button>
        {open && (
          <div role="dialog" className="absolute top-full left-1/2 z-40 mt-2 w-72 -translate-x-1/2 rounded-2xl border border-primary/30 bg-[#110d12] p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between gap-2">
              <button type="button" onClick={() => setYear((y) => y - 1)} className="rounded-full p-1 hover:text-primary" aria-label={t.period.prev}><ChevronLeft className="size-4" /></button>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded-lg border border-border bg-transparent px-2 py-1 text-sm" aria-label={locale === "ru" ? "Год" : "Year"}>
                {[...new Set([...years, year])].sort().map((y) => <option key={y} value={y} className="bg-[#110d12]">{y}</option>)}
              </select>
              <button type="button" onClick={() => setYear((y) => y + 1)} className="rounded-full p-1 hover:text-primary" aria-label={t.period.next}><ChevronRight className="size-4" /></button>
            </div>
            {current.kind === "year" ? (
              <button type="button" onClick={() => go(range("year", year))} className="w-full rounded-lg border border-border py-2 text-sm hover:border-primary/60">{year}</button>
            ) : (
              <div className={cn("grid gap-1.5", current.kind === "month" ? "grid-cols-4" : "grid-cols-2")}>
                {(current.kind === "month" ? MONTHS[locale] : ["Q1", "Q2", "Q3", "Q4"]).map((label, i) => {
                  const target = range(current.kind, year, i + 1)
                  const active = target.key === current.key
                  return (
                    <button key={label} type="button" onClick={() => go(target)} className={cn("rounded-lg border py-1.5 text-sm", active ? "border-primary bg-primary/15 text-primary" : "border-border hover:border-primary/60")}>
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
            <button type="button" onClick={() => go(today)} className="mt-2 w-full rounded-lg py-1.5 text-xs text-primary hover:bg-primary/10">
              {locale === "ru" ? (current.kind === "month" ? "Текущий месяц" : current.kind === "quarter" ? "Текущий квартал" : "Текущий год") : current.kind === "month" ? "Current month" : current.kind === "quarter" ? "Current quarter" : "Current year"}
            </button>
          </div>
        )}
      </div>
      <button type="button" onClick={() => go(next(current))} aria-label={t.period.next} className="flex size-8 items-center justify-center rounded-full border border-border hover:border-primary/60 hover:text-primary">
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}
