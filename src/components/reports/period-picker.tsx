"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { cn } from "cn"

import { useI18n } from "@/lib/i18n/client"
import { reportTexts } from "@/lib/i18n/reports"
import { parseRange, previous, range, rangeLabel, type PeriodKind, type Range } from "@/lib/reports/periods"

function next(r: Range): Range {
  if (r.kind === "year") return range("year", r.year + 1)
  const count = r.kind === "month" ? 12 : 4
  return r.index < count ? range(r.kind, r.year, r.index + 1) : range(r.kind, r.year + 1, 1)
}

/** Month / quarter / year switch with previous/next; stores the period in ?p= (2026-05, 2026-Q2, 2026). */
export function PeriodPicker({ value, kinds = ["month", "quarter", "year"] }: { value: string; kinds?: PeriodKind[] }) {
  const { locale } = useI18n()
  const t = reportTexts[locale]
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const current = parseRange(value, range("month", new Date().getUTCFullYear(), new Date().getUTCMonth() + 1))
  const go = (r: Range) => {
    const next = new URLSearchParams(params.toString())
    next.set("p", r.key)
    router.push(`${pathname}?${next.toString()}`)
  }
  const switchKind = (kind: PeriodKind) => {
    const month = current.kind === "month" ? current.index : current.kind === "quarter" ? (current.index - 1) * 3 + 1 : 1
    go(kind === "month" ? range("month", current.year, month) : kind === "quarter" ? range("quarter", current.year, Math.ceil(month / 3)) : range("year", current.year))
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" className="flex rounded-full border border-border p-0.5 text-sm">
        {kinds.map((k) => (
          <button key={k} type="button" aria-pressed={current.kind === k} onClick={() => switchKind(k)} className={cn("rounded-full px-3 py-1", current.kind === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {t.period[k]}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => go(previous(current))} aria-label={t.period.prev} className="flex size-8 items-center justify-center rounded-full border border-border hover:border-primary/60 hover:text-primary">
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-36 text-center font-display text-lg font-black uppercase italic">{rangeLabel(current, locale)}</span>
      <button type="button" onClick={() => go(next(current))} aria-label={t.period.next} className="flex size-8 items-center justify-center rounded-full border border-border hover:border-primary/60 hover:text-primary">
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}
