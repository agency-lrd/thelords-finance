"use client"

import Decimal from "decimal.js"
import { Check, Plus, Trash2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, useTransition } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select, Textarea } from "@/components/ui/form-controls"
import type { getProjectLedger, LedgerKind } from "@/lib/data/project-ledger"
import { dictionaries, fill, type Dictionary } from "@/lib/i18n/dictionaries"
import { formatAmount, normalizeNumber, type Locale } from "@/lib/i18n/format"

import { addLedgerAction, confirmLedgerAction, deleteLedgerAction, settleLedgerAction, updateLedgerAction, type LedgerFormInput } from "./actions"
import { NO_DEPT, paletteFor, PALETTE } from "./palette"
import { CarryCostsButton } from "./recurring-costs"

type Ledger = Awaited<ReturnType<typeof getProjectLedger>>
type Row = Ledger["income"][number] | Ledger["costs"][number]

type Props = {
  locale: Locale
  monthKey: string
  baseCurrency: string
  ledger: Ledger
  /** Department payroll for the contribution table (approved where confirmed, otherwise calculated). */
  payrollByDepartment: Record<string, string>
  accounts: { id: string; name: string; currency: string }[]
  canManage: boolean
  open: boolean
}

const CURRENCIES = ["USD", "USDT", "EUR", "GBP"] as const

export function ProjectLedger(props: Props) {
  const { locale, ledger, baseCurrency } = props
  const t = dictionaries[locale] as Dictionary
  const router = useRouter()
  const [, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Row | null>(null)
  const refresh = () => startRefresh(() => router.refresh())
  const editable = props.canManage && props.open

  const colorOf = useMemo(() => {
    const index = new Map(ledger.departments.map((d, i) => [d.id, { i, color: d.color }]))
    return (id: string | null) => (id && index.has(id) ? paletteFor(index.get(id)!.color, index.get(id)!.i) : NO_DEPT)
  }, [ledger.departments])

  const money = (v: Decimal | string) => formatAmount(new Decimal(v).toString(), baseCurrency, locale)
  const sumBase = (rows: Row[], onlyConfirmed = false) => rows.filter((r) => !onlyConfirmed || r.confirmed).reduce((acc, r) => acc.add(r.baseAmount), new Decimal(0))

  const contribution = ledger.departments
    .map((d) => {
      const income = sumBase(ledger.income.filter((r) => r.departmentId === d.id), true)
      const costs = sumBase(ledger.costs.filter((r) => r.departmentId === d.id), true)
      const payroll = new Decimal(props.payrollByDepartment[d.id] ?? 0)
      return { id: d.id, name: d.name, income, costs, payroll, value: income.sub(costs).sub(payroll) }
    })
    .filter((r) => !r.income.isZero() || !r.costs.isZero() || !r.payroll.isZero())
  const totals = contribution.reduce(
    (acc, r) => ({ income: acc.income.add(r.income), costs: acc.costs.add(r.costs), payroll: acc.payroll.add(r.payroll), value: acc.value.add(r.value) }),
    { income: new Decimal(0), costs: new Decimal(0), payroll: new Decimal(0), value: new Decimal(0) },
  )
  const maxAbs = contribution.reduce((m, r) => Decimal.max(m, r.value.abs()), new Decimal(1))

  return (
    <div className="mt-12 flex flex-col gap-12">
      {error && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">
          {error}
        </p>
      )}
      {(["cost", "income"] as const).map((kind) => (
        <Block
          key={kind}
          kind={kind}
          locale={locale}
          rows={kind === "income" ? ledger.income : ledger.costs}
          departments={ledger.departments}
          colorOf={colorOf}
          t={t}
          money={money}
          monthKey={props.monthKey}
          editable={editable}
          extra={kind === "cost" && editable ? <CarryCostsButton locale={locale} monthKey={props.monthKey} ledger={ledger} onDone={() => { setError(null); refresh() }} onError={setError} /> : null}
          onError={setError}
          onEdit={setEditing}
          onDone={() => {
            setError(null)
            refresh()
          }}
        />
      ))}


      {/* Department contribution ("Net profit company" in the original sheet, correctly named) */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-2xl font-black uppercase italic">{t.ledger.contributionTitle}</h2>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{t.ledger.contributionHint}</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <div className="overflow-x-auto rounded-2xl ring-1 ring-foreground/10">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                <tr>
                  {["", t.ledger.income, t.ledger.costs, t.ledger.payroll, t.ledger.contribution, t.ledger.margin].map((h, i) => (
                    <th key={i} className={cn("px-3 py-2.5 font-medium", i > 0 && "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contribution.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">{t.common.noData}</td>
                  </tr>
                )}
                {contribution.map((r) => (
                  <tr key={r.id} className="border-t border-border/60">
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2"><span className={cn("size-2 rounded-full", colorOf(r.id).bar)} />{r.name}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(r.income)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(r.costs)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(r.payroll)}</td>
                    <td className={cn("px-3 py-2.5 text-right font-mono font-semibold", r.value.isNegative() ? "text-red-300" : "text-foreground")}>{money(r.value)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{r.income.isZero() ? "—" : `${r.value.div(r.income).mul(100).toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
              {contribution.length > 0 && (
                <tfoot>
                  <tr className="border-t border-primary/40 bg-[#3a0d29] font-semibold text-white">
                    <td className="px-3 py-2.5">{t.common.total}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(totals.income)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(totals.costs)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(totals.payroll)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{money(totals.value)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{totals.income.isZero() ? "—" : `${totals.value.div(totals.income).mul(100).toFixed(1)}%`}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {/* Diverging bars: positive contribution up, negative down (like the sheet's chart). */}
          <div className="flex min-h-56 items-stretch gap-4 rounded-2xl bg-card/50 p-5 ring-1 ring-foreground/10">
            {contribution.map((r) => {
              const h = r.value.abs().div(maxAbs).mul(100).toNumber()
              return (
                <div key={r.id} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                  <div className="flex w-full flex-1 flex-col">
                    <div className="flex flex-1 items-end justify-center border-b border-white/30">
                      {!r.value.isNegative() && <div className="w-3/5 rounded-t-md bg-primary" style={{ height: `${h}%` }} title={money(r.value)} />}
                    </div>
                    <div className="flex flex-1 items-start justify-center">
                      {r.value.isNegative() && <div className="w-3/5 rounded-b-md bg-red-500/80" style={{ height: `${h}%` }} title={money(r.value)} />}
                    </div>
                  </div>
                  <span className="w-full truncate text-center text-[11px] text-muted-foreground">{r.name}</span>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {editing && (
        <RowDialog
          row={editing}
          ledger={ledger}
          accounts={props.accounts}
          editable={editable}
          locale={locale}
          t={t}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function Block(props: {
  kind: LedgerKind
  locale: Locale
  rows: Row[]
  departments: Ledger["departments"]
  colorOf: (id: string | null) => (typeof PALETTE)[number]
  t: Dictionary
  money: (v: Decimal | string) => string
  monthKey: string
  editable: boolean
  /** Controls shown under the block title (the costs block: carry recurring costs). */
  extra?: React.ReactNode
  onError: (message: string | null) => void
  onEdit: (row: Row) => void
  onDone: () => void
}) {
  const { kind, rows, t } = props
  const used = new Set(rows.map((r) => r.departmentId))
  const [extra, setExtra] = useState<string[]>([])
  const shown = props.departments.filter((d) => used.has(d.id) || extra.includes(d.id))
  const hidden = props.departments.filter((d) => !used.has(d.id) && !extra.includes(d.id))
  const all = rows.reduce((acc, r) => acc.add(r.baseAmount), new Decimal(0))
  const confirmed = rows.filter((r) => r.confirmed).reduce((acc, r) => acc.add(r.baseAmount), new Decimal(0))

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-black uppercase italic">{kind === "income" ? t.ledger.incomeTitle : t.ledger.costsTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{kind === "income" ? t.ledger.incomeHint : t.ledger.costsHint}</p>
          {props.extra && <div className="mt-2">{props.extra}</div>}
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{kind === "income" ? t.ledger.totalIncome : t.ledger.totalCost}</p>
          <p className="font-display text-2xl font-black">{props.money(all)}</p>
          <p className="text-[11px] text-muted-foreground">{t.ledger.confirmedTotal}: {props.money(confirmed)}</p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {shown.map((d) => (
          <DepartmentCard key={d.id} {...props} department={d} rows={rows.filter((r) => r.departmentId === d.id)} palette={props.colorOf(d.id)} />
        ))}
        {props.editable && hidden.length > 0 && (
          <div className="flex min-h-40 items-center justify-center rounded-2xl border border-dashed border-border p-4">
            <Select value="" onChange={(e) => e.target.value && setExtra((x) => [...x, e.target.value])} className="h-9 w-full max-w-60" aria-label={t.sheet.col.department}>
              <option value="">+ {t.sheet.col.department}…</option>
              {hidden.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </div>
        )}
        {!props.editable && shown.length === 0 && <p className="text-sm text-muted-foreground">{t.common.noData}</p>}
      </div>
    </section>
  )
}

function DepartmentCard(props: {
  kind: LedgerKind
  locale: Locale
  department: Ledger["departments"][number]
  rows: Row[]
  palette: (typeof PALETTE)[number]
  t: Dictionary
  money: (v: Decimal | string) => string
  monthKey: string
  editable: boolean
  onError: (message: string | null) => void
  onEdit: (row: Row) => void
  onDone: () => void
}) {
  const { kind, department, rows, t } = props
  const [item, setItem] = useState("")
  const [amount, setAmount] = useState("")
  const [teamId, setTeamId] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const total = rows.reduce((acc, r) => acc.add(r.baseAmount), new Decimal(0))

  async function add(allowDuplicate = false) {
    const value = normalizeNumber(amount)
    if (!item.trim() || !value) return
    setBusy("add")
    const input: LedgerFormInput = { departmentId: department.id, item, amount: value, currency: "USD", categoryId: "", projectId: "", clientId: "", clientName: "", teamId, date: "", notes: "" }
    const result = await addLedgerAction(props.monthKey, kind, input, allowDuplicate)
    setBusy(null)
    if (!result.ok) {
      if ("duplicate" in result && result.duplicate && window.confirm(t.ledger.duplicate)) return add(true)
      return props.onError(result.message)
    }
    setItem("")
    setAmount("")
    props.onDone()
  }

  async function toggle(row: Row) {
    setBusy(row.id)
    const result = await confirmLedgerAction(kind, row.id, !row.confirmed)
    setBusy(null)
    if (!result.ok) return props.onError(result.message)
    props.onDone()
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-card/60 ring-1 ring-foreground/10">
      <div className={cn("flex items-center justify-between gap-2 px-4 py-3", props.palette.name)}>
        <span className={cn("truncate rounded-full px-2.5 py-0.5 text-[11px] font-semibold", props.palette.chip)}>{department.name}</span>
      </div>
      <table className="w-full text-[13px]">
        <thead className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <tr className="border-b border-border/60">
            <th className="px-3 py-1.5 text-left font-medium">{department.teams.length ? `${t.ledger.item} / ${t.ledger.team}` : t.ledger.item}</th>
            <th className="px-3 py-1.5 text-right font-medium">{t.ledger.sum}</th>
            <th className="w-10 px-2 py-1.5 font-medium">✓</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={cn("border-b border-border/40 hover:bg-white/[0.03]", !r.confirmed && "text-foreground/70")}>
              <td className="max-w-0 px-3 py-1.5">
                <button type="button" onClick={() => props.onEdit(r)} className="block w-full truncate text-left hover:text-primary" title={[r.categoryName, r.clientName, r.notes].filter(Boolean).join(" · ")}>
                  {"recurring" in r && r.recurring && <span className="mr-1 text-[10px] text-primary/80" title={props.locale === "ru" ? "Повторяющийся расход" : "Recurring cost"}>↻</span>}
                  {r.item}
                  {(r.clientName || r.teamName) && <span className="ml-1.5 text-[11px] text-muted-foreground">{r.teamName ?? r.clientName}</span>}
                </button>
              </td>
              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{formatAmount(r.amount, r.currency, props.locale)}</td>
              <td className="px-2 py-1.5 text-center">
                <button
                  type="button"
                  disabled={!props.editable || busy === r.id}
                  onClick={() => toggle(r)}
                  aria-pressed={r.confirmed}
                  aria-label={t.ledger.confirm}
                  className={cn("inline-flex size-5 items-center justify-center rounded border", r.confirmed ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50", busy === r.id && "animate-pulse")}
                >
                  {r.confirmed && <Check className="size-3.5" />}
                </button>
              </td>
            </tr>
          ))}
          {props.editable && (
            <tr>
              <td className="px-2 py-1.5">
                <Input value={item} onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={t.ledger.addRow} className="h-7 text-[13px]" aria-label={t.ledger.item} maxLength={200} />
                {department.teams.length > 0 && (
                  <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="mt-1 h-7 text-[12px]" aria-label={t.ledger.team}>
                    <option value="">{t.ledger.team}: —</option>
                    {department.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                )}
              </td>
              <td className="px-2 py-1.5">
                <Input value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} inputMode="decimal" placeholder="0" className="h-7 text-right font-mono text-[13px]" aria-label={t.ledger.sum} />
              </td>
              <td className="px-1 py-1.5 text-center">
                <button type="button" onClick={() => add()} disabled={busy === "add"} aria-label={t.common.add} className="inline-flex size-6 items-center justify-center rounded-md text-primary hover:bg-primary/15">
                  <Plus className="size-4" />
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="mt-auto flex justify-between border-t border-primary/30 bg-[#3a0d29]/70 px-3 py-2 text-[13px] font-semibold">
        <span>{t.ledger.total}</span>
        <span className="font-mono">{props.money(total)}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function RowDialog(props: {
  row: Row
  ledger: Ledger
  accounts: { id: string; name: string; currency: string }[]
  editable: boolean
  locale: Locale
  t: Dictionary
  onClose: () => void
  onDone: () => void
}) {
  const { row, ledger, t } = props
  const kind = row.kind
  const locked = row.confirmed || !props.editable
  const department = ledger.departments.find((d) => d.id === row.departmentId)
  const [form, setForm] = useState({
    departmentId: row.departmentId ?? "",
    item: row.item,
    amount: row.amount,
    currency: row.currency,
    categoryId: row.categoryId,
    projectId: row.projectId ?? "",
    clientId: row.clientId ?? "",
    clientName: "",
    teamId: row.teamId ?? "",
    date: row.date,
    notes: row.notes ?? "",
    recurring: "recurring" in row && row.recurring ? "true" : "false",
  })
  const [settle, setSettle] = useState({ amount: "", financialAccountId: props.accounts[0]?.id ?? "", date: new Date().toISOString().slice(0, 10) })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const statusLabel = kind === "income" ? t.ledger.incomeStatus[row.status as keyof Dictionary["ledger"]["incomeStatus"]] : t.ledger.costStatus[row.status as keyof Dictionary["ledger"]["costStatus"]]
  const outstanding = new Decimal(row.amount).sub(row.settled)
  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    setSaving(true)
    setError(null)
    const result = await fn()
    setSaving(false)
    if (!result.ok) return setError(result.message ?? t.common.error)
    props.onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={props.onClose}>
      <div role="dialog" aria-modal="true" aria-label={row.item} className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl bg-[#141015] p-6 shadow-2xl ring-1 ring-primary/25" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-primary">{kind === "income" ? t.ledger.incomeTitle : t.ledger.costsTitle} · {department?.name}</p>
            <h2 className="font-display text-lg font-bold uppercase">{row.item}</h2>
            <p className="text-xs text-muted-foreground">{t.ledger.status}: {statusLabel}{row.confirmed ? ` · ${t.ledger.confirmed}` : ""}</p>
          </div>
        </div>

        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (locked) return run(() => updateLedgerAction(kind, row.id, kind === "cost" ? { notes: form.notes, recurring: form.recurring } : { notes: form.notes }))
            run(() => updateLedgerAction(kind, row.id, { ...form, amount: normalizeNumber(form.amount) ?? form.amount }))
          }}
        >
          <Field label={t.ledger.item} span>
            <Input value={form.item} onChange={set("item")} disabled={locked} required maxLength={200} />
          </Field>
          <Field label={t.ledger.sum}>
            <Input value={form.amount} onChange={set("amount")} disabled={locked} inputMode="decimal" required />
          </Field>
          <Field label={t.sheet.col.currency}>
            <Select value={form.currency} onChange={set("currency")} disabled={locked}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label={t.sheet.col.department}>
            <Select value={form.departmentId} onChange={set("departmentId")} disabled={locked}>
              {ledger.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.category}>
            <Select value={form.categoryId} onChange={set("categoryId")} disabled={locked}>
              {ledger.categories.filter((c) => c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.client}>
            <Select value={form.clientId} onChange={set("clientId")} disabled={locked}>
              <option value="">—</option>
              {ledger.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.newClient}>
            <Input value={form.clientName} onChange={set("clientName")} disabled={locked || !!form.clientId} maxLength={160} />
          </Field>
          <Field label={t.ledger.project}>
            <Select value={form.projectId} onChange={set("projectId")} disabled={locked}>
              <option value="">{t.ledger.noProject}</option>
              {ledger.projects.filter((p) => !p.departmentId || p.departmentId === form.departmentId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.team}>
            <Select value={form.teamId} onChange={set("teamId")} disabled={locked}>
              <option value="">—</option>
              {ledger.departments.find((d) => d.id === form.departmentId)?.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label={t.ledger.date}>
            <Input type="date" value={form.date} onChange={set("date")} disabled={locked} />
          </Field>
          {kind === "cost" && (
            <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={form.recurring === "true"} disabled={!props.editable} onChange={(e) => setForm((f) => ({ ...f, recurring: e.target.checked ? "true" : "false" }))} className="accent-[var(--primary)]" />
              {props.locale === "ru" ? "Повторяющийся ежемесячный расход (предлагать перенос в следующий месяц)" : "Recurring monthly cost (offer to carry into next month)"}
            </label>
          )}
          <Field label={t.ledger.comment} span>
            <Textarea value={form.notes} onChange={set("notes")} disabled={!props.editable} maxLength={2000} />
          </Field>
          {row.confirmed && props.editable && <p className="col-span-2 text-xs text-muted-foreground">{t.ledger.unconfirmHint}</p>}
          {error && <p role="alert" className="col-span-2 text-xs text-destructive">{error}</p>}
          <div className="col-span-2 flex flex-wrap items-center justify-between gap-2">
            {props.editable && !row.confirmed ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                onClick={() => window.confirm(fill(t.ledger.deleteConfirm, { item: row.item })) && run(() => deleteLedgerAction(kind, row.id))}
              >
                <Trash2 /> {t.ledger.delete}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={props.onClose}>{t.common.close}</Button>
              {props.editable && <Button type="submit" disabled={saving}>{saving ? t.common.saving : t.common.save}</Button>}
            </div>
          </div>
        </form>

        {row.confirmed && props.editable && outstanding.gt(0) && row.status !== "PAID" && (
          <div className="mt-6 border-t border-border pt-5">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              {kind === "income" ? t.ledger.recordReceipt : t.ledger.recordPayment} · {formatAmount(outstanding.toString(), row.currency, props.locale)}
            </p>
            {props.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t.ledger.noAccounts} <Link href="/accounts" className="text-primary hover:underline">{t.nav.accounts} →</Link>
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {kind === "income" && (
                  <Field label={t.ledger.sum}>
                    <Input value={settle.amount} onChange={(e) => setSettle((s) => ({ ...s, amount: e.target.value }))} placeholder={outstanding.toString()} inputMode="decimal" />
                  </Field>
                )}
                <Field label={t.ledger.account}>
                  <Select value={settle.financialAccountId} onChange={(e) => setSettle((s) => ({ ...s, financialAccountId: e.target.value }))}>
                    {props.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </Field>
                <Field label={t.ledger.date}>
                  <Input type="date" value={settle.date} onChange={(e) => setSettle((s) => ({ ...s, date: e.target.value }))} />
                </Field>
                <div className="col-span-3 flex justify-end">
                  <Button type="button" disabled={saving} onClick={() => run(() => settleLedgerAction(kind, row.id, { ...settle, amount: normalizeNumber(settle.amount) ?? "" }))}>
                    {kind === "income" ? t.ledger.recordReceipt : t.ledger.recordPayment}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, span, children }: { label: string; span?: boolean; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-xs font-medium text-muted-foreground", span && "col-span-2")}>
      {label}
      {children}
    </label>
  )
}
