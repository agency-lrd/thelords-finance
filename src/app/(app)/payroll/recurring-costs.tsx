"use client"

import { Copy, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { getProjectLedger } from "@/lib/data/project-ledger"
import type { Locale } from "@/lib/i18n/format"

import { carryCostsAction, recurringPreviewAction } from "./actions"
import { Panel } from "./sheet-admin"

type Ledger = Awaited<ReturnType<typeof getProjectLedger>>

const T = {
  ru: {
    carry: "Перенести повторяющиеся расходы из прошлого месяца",
    carryTitle: "Перенос повторяющихся расходов из {month}",
    carryHint: "Переносятся только повторяющиеся (плановые) расходы: они создаются как «план» и попадут в P&L только после подтверждения, а в Cash Flow — только после оплаты. Фактические доходы, прибыль и платежи прошлого месяца не копируются. Прошлый месяц не меняется.",
    noRecurring: "В прошлом месяце нет расходов с отметкой «повторяющийся». Отметьте их в карточке расхода.",
    already: "уже перенесено",
    item: "Статья",
    department: "Отдел",
    team: "Команда",
    amount: "Сумма",
    keepRecurring: "повторять",
    carryButton: "Перенести выбранные ({n})",
    carryDone: "Перенесено: {added}, пропущено (уже есть): {skipped}",
    cancel: "Отмена",
  },
  en: {
    carry: "Carry recurring costs from last month",
    carryTitle: "Carry recurring costs from {month}",
    carryHint: "Only recurring (planned) costs are carried: created as planned, they reach the P&L only when confirmed and Cash Flow only when paid. Last month's actual income, profit and payments are never copied. Last month does not change.",
    noRecurring: "Last month has no costs marked recurring. Mark them in the cost's card.",
    already: "already carried",
    item: "Item",
    department: "Department",
    team: "Team",
    amount: "Amount",
    keepRecurring: "recurring",
    carryButton: "Carry selected ({n})",
    carryDone: "Carried: {added}, skipped (already there): {skipped}",
    cancel: "Cancel",
  },
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""))

/** "Carry recurring costs" button and dialog for the project costs block (plans only, never actuals). */
export function CarryCostsButton(props: { locale: Locale; monthKey: string; ledger: Ledger; onDone: () => void; onError: (m: string) => void }) {
  const t = T[props.locale]
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Copy /> {t.carry}</Button>
      {open && <CarryCostsDialog t={t} locale={props.locale} monthKey={props.monthKey} ledger={props.ledger} onClose={() => setOpen(false)} onDone={(message) => { setOpen(false); window.alert(message); props.onDone() }} onError={props.onError} />}
    </>
  )
}

type Preview = Extract<Awaited<ReturnType<typeof recurringPreviewAction>>, { ok: true }>["preview"]

function CarryCostsDialog(props: { t: (typeof T)["ru"]; locale: Locale; monthKey: string; ledger: Ledger; onClose: () => void; onDone: (message: string) => void; onError: (m: string) => void }) {
  const { t } = props
  const [preview, setPreview] = useState<Preview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, { selected: boolean; item: string; amount: string; teamId: string; recurring: boolean }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    recurringPreviewAction(props.monthKey).then((r) => {
      if (!alive) return
      if (!r.ok) return setError(r.message)
      setPreview(r.preview)
      setDrafts(Object.fromEntries(r.preview.rows.map((x) => [x.id, { selected: !x.present, item: x.item, amount: x.amount, teamId: x.teamId ?? "", recurring: true }])))
    })
    return () => {
      alive = false
    }
  }, [props.monthKey])
  const selected = Object.entries(drafts).filter(([, d]) => d.selected)
  const set = (id: string, patch: Partial<(typeof drafts)[string]>) => setDrafts((all) => ({ ...all, [id]: { ...all[id], ...patch } }))

  return (
    <Panel title={fill(t.carryTitle, { month: preview?.previous ?? "…" })} onClose={props.onClose} wide>
      <p className="text-xs text-muted-foreground">{t.carryHint}</p>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">{error}</p>}
      {!preview ? (
        !error && <Loader2 className="size-4 animate-spin" />
      ) : preview.rows.length === 0 ? (
        <p className="text-sm text-amber-300">{t.noRecurring}</p>
      ) : (
        <div className="max-h-[50vh] overflow-auto rounded-xl border border-border/60">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#110d12] text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              <tr><th className="px-2 py-1.5" /><th className="px-2 py-1.5 text-left">{t.item}</th><th className="px-2 py-1.5 text-left">{t.department}</th><th className="px-2 py-1.5 text-left">{t.team}</th><th className="px-2 py-1.5 text-right">{t.amount}</th><th className="px-2 py-1.5" /></tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => {
                const d = drafts[r.id]
                if (!d) return null
                const teams = props.ledger.departments.find((x) => x.id === r.departmentId)?.teams ?? []
                return (
                  <tr key={r.id} className={cn("border-t border-border/40", r.present && "opacity-60")}>
                    <td className="px-2 py-1"><input type="checkbox" disabled={r.present} checked={d.selected && !r.present} onChange={(e) => set(r.id, { selected: e.target.checked })} aria-label={r.item} className="accent-[var(--primary)]" /></td>
                    <td className="px-2 py-1"><Input value={d.item} disabled={r.present} onChange={(e) => set(r.id, { item: e.target.value })} className="h-7 text-xs" /><span className="text-[10px] text-muted-foreground">{r.categoryName}{r.present ? ` · ${t.already}` : ""}</span></td>
                    <td className="px-2 py-1 text-muted-foreground">{r.departmentName ?? "—"}</td>
                    <td className="px-2 py-1"><Select value={d.teamId} disabled={r.present} onChange={(e) => set(r.id, { teamId: e.target.value })} className="h-7 w-36 text-xs"><option value="">—</option>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></td>
                    <td className="px-2 py-1 text-right"><Input value={d.amount} disabled={r.present} onChange={(e) => set(r.id, { amount: e.target.value })} inputMode="decimal" className="ml-auto h-7 w-24 text-right font-mono text-xs" /><span className="text-[10px] text-muted-foreground">{r.currency}</span></td>
                    <td className="px-2 py-1"><label className="flex items-center gap-1 text-[10px] text-muted-foreground"><input type="checkbox" disabled={r.present} checked={d.recurring} onChange={(e) => set(r.id, { recurring: e.target.checked })} className="accent-[var(--primary)]" />{t.keepRecurring}</label></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onClose}>{t.cancel}</Button>
        <Button
          disabled={busy || selected.length === 0}
          onClick={async () => {
            setBusy(true)
            const r = await carryCostsAction(props.monthKey, selected.map(([id, d]) => ({ id, item: d.item, amount: d.amount, teamId: d.teamId || null, recurring: d.recurring })))
            setBusy(false)
            if (!r.ok) return setError(r.message)
            props.onDone(fill(t.carryDone, { added: r.added, skipped: r.skipped }))
          }}
        >
          {busy && <Loader2 className="animate-spin" />} {fill(t.carryButton, { n: selected.length })}
        </Button>
      </div>
    </Panel>
  )
}
