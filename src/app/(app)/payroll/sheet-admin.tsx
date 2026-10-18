"use client"

import Decimal from "decimal.js"
import { Archive, Check, GitMerge, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import { formatAmount, normalizeNumber, type Locale } from "@/lib/i18n/format"
import type { SheetAdminTexts } from "@/lib/i18n/sheet-admin"

import {
  archiveDepartmentAction,
  archivedEmployeesAction,
  archiveEmployeeAction,
  createDepartmentAction,
  deleteDepartmentAction,
  deleteEmployeeAction,
  departmentColorAction,
  mergeDepartmentsAction,
  renameDepartmentAction,
} from "./actions"
import { PALETTE, paletteFor } from "./palette"

export type SheetDepartment = { id: string; name: string; color: string | null; archived: boolean; employees: number; hasHistory: boolean }

const fillText = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""))

function Panel({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal aria-label={title} className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn("flex max-h-[90dvh] w-full flex-col gap-4 overflow-auto rounded-t-2xl border border-primary/30 bg-[#110d12] p-5 shadow-2xl sm:rounded-2xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-black uppercase italic">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Add, rename, recolor, archive, restore, merge and delete departments. */
export function DepartmentManager(props: {
  departments: SheetDepartment[]
  monthKey: string
  monthTitle: string
  canManage: boolean
  focusAdd: boolean
  t: SheetAdminTexts
  toast: (text: string, tone?: "ok" | "error") => void
  onChanged: () => void
  onClose: () => void
}) {
  const { t, toast } = props
  const D = t.dept
  const [form, setForm] = useState({ name: "", color: PALETTE[props.departments.length % PALETTE.length].key, classification: "OPERATING_EXPENSE" })
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [merging, setMerging] = useState<{ id: string; target: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const active = props.departments.filter((d) => !d.archived)

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>, success?: string) {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (!r.ok) {
      toast(r.message ?? "Error", "error")
      return false
    }
    if (success) toast(success)
    props.onChanged()
    return true
  }

  const ordered = [...active, ...props.departments.filter((d) => d.archived)]
  return (
    <Panel title={D.title} onClose={props.onClose} wide>
      {props.canManage && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-border p-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await run(() => createDepartmentAction({ name: form.name, color: form.color, costClassification: form.classification }), D.created)) setForm((f) => ({ ...f, name: "" }))
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {D.name}
            <Input autoFocus={props.focusAdd} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} className="h-8 w-52" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {D.classification}
            <Select value={form.classification} onChange={(e) => setForm({ ...form, classification: e.target.value })} className="h-8 w-60 text-xs">
              <option value="OPERATING_EXPENSE">{D.opex}</option>
              <option value="COST_OF_SALES">{D.cos}</option>
            </Select>
          </label>
          <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {D.color}
            <div className="flex gap-1">
              {PALETTE.map((p) => (
                <button key={p.key} type="button" aria-label={p.key} aria-pressed={form.color === p.key} onClick={() => setForm({ ...form, color: p.key })} className={cn("size-6 rounded-full", p.bar, form.color === p.key ? "ring-2 ring-white ring-offset-2 ring-offset-[#110d12]" : "opacity-60 hover:opacity-100")} />
              ))}
            </div>
          </div>
          <Button type="submit" size="sm" disabled={busy || !form.name.trim()}><Plus /> {D.add}</Button>
        </form>
      )}
      <p className="text-[11px] text-muted-foreground">{D.renamedEverywhere}</p>
      <ul className="flex flex-col divide-y divide-border/50 rounded-xl border border-border/60">
        {ordered.map((d) => {
          const palette = paletteFor(d.color, active.findIndex((x) => x.id === d.id))
          return (
            <li key={d.id} className={cn("flex flex-col gap-2 px-3 py-2", d.archived && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("size-3 shrink-0 rounded-full", palette.bar)} />
                {renaming?.id === d.id ? (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (await run(() => renameDepartmentAction(d.id, renaming.name))) setRenaming(null)
                    }}
                  >
                    <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(null))} maxLength={120} className="h-7 w-56" />
                    <Button type="submit" size="icon-sm" variant="ghost" aria-label={D.rename}><Check /></Button>
                  </form>
                ) : (
                  <button type="button" disabled={!props.canManage} onDoubleClick={() => setRenaming({ id: d.id, name: d.name })} className="text-left text-sm font-medium">{d.name}</button>
                )}
                <span className="text-[11px] text-muted-foreground">{d.employees} {D.employees}{d.archived ? ` · ${D.archived}` : ""}</span>
                {props.canManage && (
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    {!d.archived && (
                      <span className="mr-1 flex gap-0.5">
                        {PALETTE.map((p) => (
                          <button key={p.key} type="button" aria-label={`${D.color} ${p.key}`} disabled={busy} onClick={() => run(() => departmentColorAction(d.id, p.key))} className={cn("size-4 rounded-full", p.bar, d.color === p.key ? "ring-2 ring-white" : "opacity-40 hover:opacity-100")} />
                        ))}
                      </span>
                    )}
                    <Button size="icon-sm" variant="ghost" aria-label={D.rename} title={D.rename} onClick={() => setRenaming({ id: d.id, name: d.name })}><Pencil /></Button>
                    {!d.archived && active.length > 1 && <Button size="icon-sm" variant="ghost" aria-label={D.merge} title={D.merge} onClick={() => setMerging({ id: d.id, target: active.find((x) => x.id !== d.id)!.id })}><GitMerge /></Button>}
                    <Button size="icon-sm" variant="ghost" aria-label={d.archived ? D.restore : D.archive} title={d.archived ? D.restore : D.archive} disabled={busy} onClick={() => run(() => archiveDepartmentAction(d.id, !d.archived, props.monthKey))}>{d.archived ? <RotateCcw /> : <Archive />}</Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={D.delete}
                      title={d.hasHistory || d.employees ? D.historyHint : D.delete}
                      disabled={busy || d.hasHistory || d.employees > 0}
                      onClick={() => window.confirm(fillText(D.deleteConfirm, { name: d.name })) && run(() => deleteDepartmentAction(d.id))}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </div>
              {merging?.id === d.id && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 p-2 text-xs">
                  <span>{fillText(D.mergeInto, { source: d.name })}</span>
                  <Select value={merging.target} onChange={(e) => setMerging({ id: d.id, target: e.target.value })} className="h-7 w-52 text-xs">
                    {active.filter((x) => x.id !== d.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      const target = active.find((x) => x.id === merging.target)
                      if (!target || !window.confirm(fillText(D.mergeConfirm, { source: d.name, target: target.name, month: props.monthTitle }))) return
                      if (await run(() => mergeDepartmentsAction(d.id, target.id, props.monthKey, true))) setMerging(null)
                    }}
                  >
                    <GitMerge /> {t.apply}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMerging(null)}>{t.cancel}</Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

type Archived = { id: string; name: string; department: string | null; archivedAt: string; hasHistory: boolean }

/** Archived employees: restore, or delete permanently when there is no financial history. */
export function ArchivePanel({ t, canManage, canDelete, toast, onChanged, onClose }: { t: SheetAdminTexts; canManage: boolean; canDelete: boolean; toast: (text: string, tone?: "ok" | "error") => void; onChanged: () => void; onClose: () => void }) {
  const A = t.archive
  const [list, setList] = useState<Archived[] | null>(null)
  const load = async () => {
    const r = await archivedEmployeesAction()
    if (r.ok) setList(r.employees)
    else toast(r.message, "error")
  }
  useEffect(() => {
    let alive = true
    archivedEmployeesAction().then((r) => {
      if (!alive) return
      if (r.ok) setList(r.employees)
      else toast(r.message, "error")
    })
    return () => {
      alive = false
    }
  }, [toast])
  return (
    <Panel title={A.title} onClose={onClose}>
      {list === null ? null : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{A.empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50 rounded-xl border border-border/60">
          {list.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-medium">{e.name}</span>
              <span className="text-[11px] text-muted-foreground">{e.department ?? "—"} · {e.archivedAt.slice(0, 10)}</span>
              {e.hasHistory && <span className="text-[11px] text-amber-300/80">{A.history}</span>}
              {canManage && (
                <span className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const r = await archiveEmployeeAction(e.id, false)
                      if (!r.ok) return toast(r.message, "error")
                      toast(A.restored)
                      onChanged()
                      load()
                    }}
                  >
                    <RotateCcw /> {A.restore}
                  </Button>
                  {canDelete && !e.hasHistory && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={async () => {
                        const typed = window.prompt(fillText(A.deletePrompt, { name: e.name }))
                        if (typed === null) return
                        const r = await deleteEmployeeAction(e.id, typed)
                        if (!r.ok) return toast(r.message, "error")
                        toast(A.deleted)
                        load()
                      }}
                    >
                      <Trash2 /> {A.delete}
                    </Button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Bulk FIX change with a before/after preview and explicit confirmation. */
export function BulkFixDialog({ rows, t, locale, monthTitle, onApply, onClose }: { rows: { employeeId: string; name: string; fix: string | null; currency: string }[]; t: SheetAdminTexts; locale: Locale; monthTitle: string; onApply: (changes: { employeeId: string; fix: string }[]) => Promise<void>; onClose: () => void }) {
  const F = t.fixDialog
  const [mode, setMode] = useState<"percent" | "amount" | "set">("percent")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const n = normalizeNumber(value)
  const changes = rows
    .map((r) => {
      if (n === null || n === "") return null
      const before = new Decimal(r.fix || 0)
      const after = mode === "percent" ? before.mul(new Decimal(1).add(new Decimal(n).div(100))) : mode === "amount" ? before.add(n) : new Decimal(n)
      return { ...r, after: after.toDecimalPlaces(2).toString(), invalid: after.isNegative() }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  const valid = changes.length > 0 && changes.every((c) => !c.invalid)
  return (
    <Panel title={F.title} onClose={onClose}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {F.mode}
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="h-8 w-44 text-xs">
            <option value="percent">{F.percent}</option>
            <option value="amount">{F.amount}</option>
            <option value="set">{F.set}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {F.value}
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder={mode === "percent" ? "10" : "500"} className="h-8 w-32" />
        </label>
      </div>
      {changes.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-xl border border-border/60">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              <tr><th className="px-2 py-1 text-left" /><th className="px-2 py-1 text-right">{F.before}</th><th className="px-2 py-1 text-right">{F.after}</th></tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.employeeId} className="border-t border-border/40">
                  <td className="px-2 py-1">{c.name}</td>
                  <td className="px-2 py-1 text-right font-mono">{c.fix ? formatAmount(c.fix, c.currency, locale) : "—"}</td>
                  <td className={cn("px-2 py-1 text-right font-mono", c.invalid ? "text-red-300" : "text-primary")}>{formatAmount(c.after, c.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{fillText(F.note, { month: monthTitle })}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t.cancel}</Button>
        <Button
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true)
            await onApply(changes.map((c) => ({ employeeId: c.employeeId, fix: c.after })))
            setBusy(false)
            onClose()
          }}
        >
          {fillText(F.confirm, { n: changes.length })}
        </Button>
      </div>
    </Panel>
  )
}
