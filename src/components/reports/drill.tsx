"use client"

import { useEffect, useState } from "react"

import { formatAmount, formatDate } from "@/lib/i18n/format"
import { useI18n } from "@/lib/i18n/client"
import { fill } from "@/lib/i18n/dictionaries"
import { reportTexts } from "@/lib/i18n/reports"
import { drillDownAction } from "@/lib/reports/actions"

type Lines = Extract<Awaited<ReturnType<typeof drillDownAction>>, { ok: true }>["lines"]

/** Wraps a report line label: clicking it opens the journal lines behind the amount. */
export function DrillLabel({ accountId, name, period, filters, currency, asOf, children }: { accountId: string; name: string; period: string; filters?: { departmentId?: string | null; clientId?: string | null }; currency: string; asOf?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="text-left hover:text-primary hover:underline underline-offset-4">
        {children}
      </button>
      {open && <DrillModal accountId={accountId} name={name} period={period} filters={filters ?? {}} currency={currency} asOf={asOf} onClose={() => setOpen(false)} />}
    </>
  )
}

function DrillModal({ accountId, name, period, filters, currency, asOf, onClose }: { accountId: string; name: string; period: string; filters: { departmentId?: string | null; clientId?: string | null }; currency: string; asOf?: string; onClose: () => void }) {
  const { locale } = useI18n()
  const t = reportTexts[locale]
  const [lines, setLines] = useState<Lines | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    drillDownAction(accountId, period, filters, asOf).then((r) => (r.ok ? setLines(r.lines) : setError(r.message)))
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [accountId, period, filters, asOf, onClose])
  const money = (v: string) => (v === "0" ? "" : formatAmount(v, currency, locale))
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={name} className="max-h-[85dvh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-[#141015] p-6 shadow-2xl ring-1 ring-primary/25" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-4 font-display text-lg font-bold uppercase">{fill(t.drill.title, { name })}</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!lines && !error && <p className="text-sm text-muted-foreground">…</p>}
        {lines && lines.length === 0 && <p className="text-sm text-muted-foreground">{t.drill.empty}</p>}
        {lines && lines.length > 0 && (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 text-left">{t.drill.entry}</th>
                <th className="py-2 pr-3 text-left">{t.drill.date}</th>
                <th className="py-2 pr-3 text-left">{t.drill.description}</th>
                <th className="py-2 pr-3 text-left">{t.drill.dims}</th>
                <th className="py-2 pr-3 text-right">{t.drill.debit}</th>
                <th className="py-2 text-right">{t.drill.credit}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-border/50">
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{l.entryNumber}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(l.date, locale)}</td>
                  <td className="py-1.5 pr-3">{l.description}{l.status === "REVERSED" && <span className="ml-1 text-[10px] text-amber-300">(reversed)</span>}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground">{[l.department, l.client, l.project, l.employee].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{money(l.debit)}</td>
                  <td className="py-1.5 text-right font-mono">{money(l.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
