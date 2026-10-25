"use client"

import { AlertTriangle, Check, CheckCircle2, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import { fill } from "@/lib/i18n/dictionaries"
import { formatAmount, normalizeNumber, type Locale } from "@/lib/i18n/format"
import type { SheetAdminTexts } from "@/lib/i18n/sheet-admin"

import { approvalPreviewAction, approveMonthAction, reopenMonthAction, carryForwardAction, carryForwardPreviewAction, confirmRowAction, editConditionsAction } from "./actions"
import { Panel } from "./sheet-admin"

type Toast = (text: string, tone?: "ok" | "error") => void
type Preview = Extract<Awaited<ReturnType<typeof approvalPreviewAction>>, { ok: true }>["preview"]

/** Monthly approval: what will be approved, what blocks it, and the approval itself. */
export function ApprovalDialog({ monthKey, monthTitle, locale, t, canConfirm, toast, onChanged, onClose }: { monthKey: string; monthTitle: string; locale: Locale; t: SheetAdminTexts; canConfirm: boolean; toast: Toast; onChanged: () => void; onClose: () => void }) {
  const P = t.payroll
  const [preview, setPreview] = useState<Preview | null>(null)
  const [comment, setComment] = useState("")
  const [reopenReason, setReopenReason] = useState("")
  const [reopenSure, setReopenSure] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const r = await approvalPreviewAction(monthKey)
    if (r.ok) setPreview(r.preview)
    else setError(r.message)
  }
  useEffect(() => {
    let alive = true
    approvalPreviewAction(monthKey).then((r) => {
      if (!alive) return
      if (r.ok) setPreview(r.preview)
      else setError(r.message)
    })
    return () => {
      alive = false
    }
  }, [monthKey])

  return (
    <Panel title={fill(P.approveTitle, { month: monthTitle })} onClose={onClose} wide>
      {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</p>}
      {!preview ? (
        !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /></p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-border p-3"><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{P.employees}</p><p className="font-display text-xl font-black">{preview.employees}</p></div>
            <div className={cn("rounded-xl border p-3", preview.confirmed === preview.employees ? "border-emerald-400/40" : "border-amber-400/40")}><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{P.confirmedCount}</p><p className="font-display text-xl font-black">{preview.confirmed} / {preview.employees}</p></div>
            <div className="col-span-2 rounded-xl border border-primary/40 p-3 sm:col-span-1">
              <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{P.factTotal}</p>
              {preview.totals.map((x) => <p key={x.currency} className="font-mono text-lg font-semibold">{formatAmount(x.amount, x.currency, locale)}</p>)}
              <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{P.calculatedTotal}</p>
              {preview.calculatedTotals.map((x) => <p key={x.currency} className="font-mono text-xs text-muted-foreground">{formatAmount(x.amount, x.currency, locale)}</p>)}
            </div>
          </div>
          {preview.corrections.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{P.corrections}</p>
              <ul className="flex max-h-40 flex-col divide-y divide-border/50 overflow-auto rounded-xl border border-border">
                {preview.corrections.map((c) => (
                  <li key={c.employeeId} className="flex flex-wrap items-center gap-x-2 px-3 py-1.5 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="font-mono text-xs">{fill(P.correctionLine, { calculated: formatAmount(c.calculated, c.currency, locale), payable: formatAmount(c.payable, c.currency, locale) })}</span>
                    <span className="text-xs text-muted-foreground">{c.reason ?? P.noReason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.reopenings.length > 0 && (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]">{P.reopenings}</p>
              {preview.reopenings.map((v) => <p key={v.version}>{fill(P.reopening, { version: String(v.version), date: v.at.slice(0, 16).replace("T", " "), who: v.by, reason: v.reason })}</p>)}
            </div>
          )}
          {preview.canReopen && (
            <div className="flex flex-col gap-2 rounded-xl border border-amber-400/40 bg-amber-400/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300">{P.reopenTitle}</p>
              <p className="text-xs text-muted-foreground">{P.reopenWarning}</p>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {P.reopenReason}
                <Input value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} maxLength={1000} className="h-8" />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={reopenSure} onChange={(e) => setReopenSure(e.target.checked)} /> {P.reopenConfirm}
              </label>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={!reopenSure || reopenReason.trim().length < 3 || !!busy}
                  onClick={async () => {
                    setBusy("reopen")
                    const r = await reopenMonthAction(monthKey, reopenReason)
                    setBusy(null)
                    if (!r.ok) return setError(r.message)
                    toast(fill(P.reopenDone, { month: monthTitle }))
                    onChanged()
                    onClose()
                  }}
                >
                  {busy === "reopen" ? <Loader2 className="animate-spin" /> : <AlertTriangle />} {P.reopenButton}
                </Button>
              </div>
            </div>
          )}
          {preview.approvedBy && <p className="text-sm text-emerald-300">{fill(P.approvedBy, { date: preview.approvedAt!.slice(0, 16).replace("T", " "), who: preview.approvedBy })}</p>}
          {!preview.editable && !preview.approvedBy && <p className="text-sm text-amber-300">{P.notEditable}</p>}
          {preview.editable && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{P.issues}</p>
              {preview.issues.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="size-4" /> {P.noIssues}</p>
              ) : (
                <ul className="flex max-h-60 flex-col divide-y divide-border/50 overflow-auto rounded-xl border border-amber-400/30">
                  {preview.issues.map((i) => (
                    <li key={i.employeeId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="font-medium">{i.name}</span>
                      <span className="text-xs text-amber-300">{P.reason[i.reason]}</span>
                      {canConfirm && (i.reason === "unconfirmed" || i.reason === "changed") && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto"
                          disabled={!!busy}
                          onClick={async () => {
                            setBusy(i.employeeId)
                            const r = await confirmRowAction(monthKey, i.employeeId, true)
                            setBusy(null)
                            if (!r.ok) return toast(r.message, "error")
                            toast(fill(P.confirmed, { name: i.name }))
                            onChanged()
                            load()
                          }}
                        >
                          {busy === i.employeeId ? <Loader2 className="animate-spin" /> : <Check />} {P.confirmRow}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {P.comment}
                <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} className="h-8" />
              </label>
              <p className="text-[11px] text-muted-foreground">{P.approveNote}</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
                <Button
                  disabled={!preview.canApprove || !!busy}
                  onClick={async () => {
                    setBusy("approve")
                    const r = await approveMonthAction(monthKey, comment)
                    setBusy(null)
                    if (!r.ok) {
                      setError(r.message)
                      return load()
                    }
                    toast(fill(P.approvedDone, { month: monthTitle }))
                    onChanged()
                    onClose()
                  }}
                >
                  {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} {P.approveButton}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

type CarryPreview = Extract<Awaited<ReturnType<typeof carryForwardPreviewAction>>, { ok: true }>["preview"]
type Draft = { selected: boolean; fix: string; currency: string; departmentId: string; ratePct: string; kpiTarget: string; kpiRecurring: boolean }

/** Moves employees from the immediately previous, approved month (preview, choose, edit, confirm). */
export function CarryForwardDialog({ monthKey, departments, locale, t, toast, onChanged, onClose }: { monthKey: string; monthTitle: string; departments: { id: string; name: string }[]; locale: Locale; t: SheetAdminTexts; toast: Toast; onChanged: () => void; onClose: () => void }) {
  const P = t.payroll
  const [preview, setPreview] = useState<CarryPreview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [addNew, setAddNew] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    carryForwardPreviewAction(monthKey).then((r) => {
      if (!alive) return
      if (!r.ok) return toast(r.message, "error")
      setPreview(r.preview)
      setDrafts(Object.fromEntries(r.preview.employees.map((e) => [e.employeeId, { selected: r.preview.previousApproved && !e.present && !e.terminated, fix: e.fix ?? "", currency: e.currency, departmentId: e.departmentId ?? "", ratePct: e.ratePct ?? "", kpiTarget: e.kpiTarget ?? "", kpiRecurring: e.kpiRecurring }])))
    })
    return () => {
      alive = false
    }
  }, [monthKey, toast])
  const set = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  const selectable = (e: CarryPreview["employees"][number]) => !!preview?.previousApproved && !e.present && !e.terminated
  const chosen = preview?.employees.filter((e) => selectable(e) && drafts[e.employeeId]?.selected) ?? []
  const [py, pm] = (preview?.previous ?? monthKey).split("-").map(Number)
  const prevTitle = new Date(Date.UTC(py, pm - 1, 1)).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" }).replace(" г.", "")
  const count = chosen.length + addNew.size
  const L = locale === "ru" ? { employee: "Сотрудник", department: "Отдел", since: "начало работы", was: "было" } : { employee: "Employee", department: "Department", since: "started", was: "was" }

  return (
    <Panel title={fill(P.carryTitle, { month: prevTitle })} onClose={onClose} wide>
      <p className="text-xs text-muted-foreground">{P.carryHint}</p>
      {!preview ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          {!preview.previousApproved && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {fill(P.notApproved, { month: prevTitle })}
            </p>
          )}
          {preview.employees.length > 0 && (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                <Button size="sm" variant="outline" disabled={!preview.previousApproved} onClick={() => preview.employees.forEach((e) => set(e.employeeId, { selected: selectable(e) }))}>{P.selectAll}</Button>
                <Button size="sm" variant="ghost" onClick={() => preview.employees.forEach((e) => set(e.employeeId, { selected: false }))}>{t.cancel}</Button>
              </div>
              <div className="max-h-[45vh] overflow-auto rounded-xl border border-border/60">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[#110d12] text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5" />
                      <th className="px-2 py-1.5 text-left">{L.employee}</th>
                      <th className="px-2 py-1.5 text-left">{L.department}</th>
                      <th className="px-2 py-1.5 text-right">FIX</th>
                      <th className="px-2 py-1.5 text-right">%</th>
                      <th className="px-2 py-1.5 text-right">KPI Profit</th>
                      <th className="px-2 py-1.5 text-left">Add Terms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.employees.map((e) => {
                      const d = drafts[e.employeeId]
                      if (!d) return null
                      const can = selectable(e)
                      return (
                        <tr key={e.employeeId} className={cn("border-t border-border/40 align-middle", !can && "opacity-60")}>
                          <td className="px-2 py-1"><input type="checkbox" aria-label={e.name} disabled={!can} checked={can && d.selected} onChange={(x) => set(e.employeeId, { selected: x.target.checked })} className="accent-[var(--primary)]" /></td>
                          <td className="px-2 py-1">
                            <p className="font-medium">{e.name}</p>
                            <p className={cn("text-[10px]", e.present || e.terminated ? "text-muted-foreground" : "text-amber-300")}>
                              {e.present ? P.present : e.terminated ? P.terminated : P.missing} · {L.since} {e.hireDate}
                            </p>
                          </td>
                          <td className="px-2 py-1">
                            <Select disabled={!can} value={d.departmentId} onChange={(x) => set(e.employeeId, { departmentId: x.target.value })} className="h-7 w-40 text-xs">
                              {departments.map((dep) => <option key={dep.id} value={dep.id}>{dep.name}</option>)}
                            </Select>
                            <p className="text-[10px] text-muted-foreground">{L.was}: {e.departmentName ?? "—"}</p>
                          </td>
                          <td className="px-2 py-1 text-right"><Input disabled={!can} value={d.fix} onChange={(x) => set(e.employeeId, { fix: x.target.value })} inputMode="decimal" className="ml-auto h-7 w-24 text-right font-mono" /><span className="text-[10px] text-muted-foreground">{L.was}: {e.fix ?? "—"} {d.currency}</span></td>
                          <td className="px-2 py-1 text-right">{["NONE", "PCT_ABOVE_KPI", "PCT_OF_PROFIT", "PCT_IF_KPI_MET"].includes(e.model) ? <><Input disabled={!can} value={d.ratePct} onChange={(x) => set(e.employeeId, { ratePct: x.target.value })} inputMode="decimal" className="ml-auto h-7 w-16 text-right font-mono" /><span className="text-[10px] text-muted-foreground">{L.was}: {e.ratePct ? `${e.ratePct}%` : "—"}</span></> : <span className="text-muted-foreground">—</span>}</td>
                          <td className="px-2 py-1 text-right">
                            <Input disabled={!can} value={d.kpiTarget} onChange={(x) => set(e.employeeId, { kpiTarget: x.target.value })} inputMode="decimal" className="ml-auto h-7 w-24 text-right font-mono" />
                            <span className="text-[10px] text-muted-foreground">{L.was}: {e.previousKpi ?? "—"}</span>
                            <label className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground"><input type="checkbox" disabled={!can} checked={d.kpiRecurring} onChange={(x) => set(e.employeeId, { kpiRecurring: x.target.checked })} className="accent-[var(--primary)]" /> {P.recurring}</label>
                          </td>
                          <td className="max-w-48 px-2 py-1 text-[11px] text-muted-foreground">{e.terms ?? "—"}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {preview.others.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{P.others}</p>
              <p className="text-[11px] text-muted-foreground">{P.othersHint}</p>
              {preview.others.map((o) => (
                <label key={o.employeeId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={addNew.has(o.employeeId)}
                    onChange={(x) =>
                      setAddNew((s) => {
                        const next = new Set(s)
                        if (x.target.checked) next.add(o.employeeId)
                        else next.delete(o.employeeId)
                        return next
                      })
                    }
                    className="accent-[var(--primary)]"
                  />
                  {o.name} <span className="text-[11px] text-muted-foreground">{L.since} {o.hireDate}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
            <Button
              disabled={busy || count === 0}
              onClick={async () => {
                setBusy(true)
                const items = chosen.map((e) => {
                  const d = drafts[e.employeeId]
                  return {
                    employeeId: e.employeeId,
                    fix: d.fix && normalizeNumber(d.fix) !== e.fix ? (normalizeNumber(d.fix) ?? d.fix) : null,
                    currency: d.currency !== e.currency ? d.currency : null,
                    departmentId: d.departmentId || null,
                    kpiTarget: d.kpiTarget ? (normalizeNumber(d.kpiTarget) ?? d.kpiTarget) : null,
                    kpiRecurring: d.kpiRecurring,
                    ratePct: d.ratePct && d.ratePct !== e.ratePct ? d.ratePct : null,
                  }
                })
                const r = await carryForwardAction(monthKey, items, [...addNew])
                setBusy(false)
                if (!r.ok) return toast(r.message, "error")
                toast(fill(P.carryDone, { added: r.result.added, skipped: r.result.skipped }))
                onChanged()
                onClose()
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null} {fill(P.carryButton, { n: count })}
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

/** Salary terms of one employee with the scope of the change. */
export function ConditionsDialog({ monthKey, row, t, toast, onChanged, onClose }: { monthKey: string; row: { employeeId: string; name: string; fix: string | null; currency: string; kpiTarget: string | null; kpiTargetInherited: boolean }; t: SheetAdminTexts; toast: Toast; onChanged: () => void; onClose: () => void }) {
  const P = t.payroll
  const [fix, setFix] = useState(row.fix ?? "")
  const [currency, setCurrency] = useState(row.currency)
  const [kpi, setKpi] = useState(row.kpiTarget ?? "")
  const [scope, setScope] = useState<"month" | "future">("future")
  const [busy, setBusy] = useState(false)
  return (
    <Panel title={fill(P.conditionsTitle, { name: row.name })} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">FIX<Input value={fix} onChange={(e) => setFix(e.target.value)} inputMode="decimal" className="h-8 font-mono" /></label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">{P.currency}
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="h-8">{["USD", "USDT", "EUR", "GBP"].map((c) => <option key={c}>{c}</option>)}</Select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">KPI Profit<Input value={kpi} onChange={(e) => setKpi(e.target.value)} inputMode="decimal" className="h-8 font-mono" /></label>
      </div>
      {row.kpiTargetInherited && <p className="text-[11px] text-muted-foreground">↻ {P.inherited}</p>}
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-[11px] text-muted-foreground">{P.scope}</legend>
        <label className="flex items-center gap-2"><input type="radio" name="scope" checked={scope === "month"} onChange={() => setScope("month")} className="accent-[var(--primary)]" /> {P.scopeMonth}</label>
        <label className="flex items-center gap-2"><input type="radio" name="scope" checked={scope === "future"} onChange={() => setScope("future")} className="accent-[var(--primary)]" /> {P.scopeFuture}</label>
      </fieldset>
      <p className="text-[11px] text-muted-foreground">{P.scopeNote}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await editConditionsAction(monthKey, row.employeeId, {
              fix: normalizeNumber(fix) ?? fix,
              currency,
              kpiTarget: kpi === "" ? "" : (normalizeNumber(kpi) ?? kpi),
              scope,
              expected: { fix: row.fix ?? "", currency: row.currency, kpiTarget: row.kpiTarget ?? "" },
            })
            setBusy(false)
            if (!r.ok) return toast(r.message, "error")
            toast(r.unconfirmed ? `${P.saved} · ${P.reconfirm}` : P.saved)
            onChanged()
            onClose()
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Check />} {P.save}
        </Button>
      </div>
    </Panel>
  )
}
