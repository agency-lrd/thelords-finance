"use client"

import Decimal from "decimal.js"
import { Archive, ArrowDown, ArrowUp, Copy, Loader2, Pencil, Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { getProjectLedger } from "@/lib/data/project-ledger"
import { formatAmount, type Locale } from "@/lib/i18n/format"

import { carryCostsAction, createTeamAction, recurringPreviewAction, setEmployeeTeamAction, updateTeamAction } from "./actions"
import { Panel } from "./sheet-admin"

type Ledger = Awaited<ReturnType<typeof getProjectLedger>>

const T = {
  ru: {
    title: "Команды: доходы, расходы и прибыль",
    hint: "Доходы и прямые расходы команд из блоков выше (только подтверждённые строки). Зарплата команды — это часть зарплаты отдела (по сотрудникам, назначенным в команду): она показана для анализа и не добавляется к итогам второй раз.",
    team: "Команда",
    revenue: "Выручка",
    costs: "Прямые расходы",
    payroll: "Зарплата команды",
    gross: "Валовая прибыль",
    margin: "Маржа",
    unconfirmed: "не подтверждено",
    add: "Добавить команду",
    name: "Название команды",
    department: "Отдел",
    rename: "Переименовать",
    archive: "В архив",
    members: "Сотрудники",
    addMember: "+ сотрудник",
    noTeams: "Команд пока нет. Создайте, например, «Команда Саня» в отделе Influence.",
    carry: "Перенести команды и расходы из прошлого месяца",
    carryTitle: "Перенос повторяющихся расходов из {month}",
    carryHint: "Команды постоянные и уже доступны в этом месяце. Переносятся только повторяющиеся (плановые) расходы: они создаются как «план» и попадут в P&L только после подтверждения, а в Cash Flow — только после оплаты. Фактические доходы, прибыль и платежи прошлого месяца не копируются. Прошлый месяц не меняется.",
    noRecurring: "В прошлом месяце нет расходов с отметкой «повторяющийся». Отметьте их в карточке расхода.",
    already: "уже перенесено",
    item: "Статья",
    amount: "Сумма",
    keepRecurring: "повторять",
    carryButton: "Перенести выбранные ({n})",
    carryDone: "Перенесено: {added}, пропущено (уже есть): {skipped}",
    total: "Итого по командам",
    cancel: "Отмена",
  },
  en: {
    title: "Teams: income, costs and profit",
    hint: "Team income and direct costs from the blocks above (confirmed rows only). Team payroll is part of the department's payroll (employees assigned to the team): shown for analysis, never added to the totals twice.",
    team: "Team",
    revenue: "Revenue",
    costs: "Direct costs",
    payroll: "Team payroll",
    gross: "Gross profit",
    margin: "Margin",
    unconfirmed: "unconfirmed",
    add: "Add team",
    name: "Team name",
    department: "Department",
    rename: "Rename",
    archive: "Archive",
    members: "Employees",
    addMember: "+ employee",
    noTeams: "No teams yet. Create one, e.g. “Team Sanya” in Influence.",
    carry: "Carry teams and costs from last month",
    carryTitle: "Carry recurring costs from {month}",
    carryHint: "Teams are permanent and already available this month. Only recurring (planned) costs are carried: created as planned, they reach the P&L only when confirmed and Cash Flow only when paid. Last month's actual income, profit and payments are never copied. Last month does not change.",
    noRecurring: "Last month has no costs marked recurring. Mark them in the cost's card.",
    already: "already carried",
    item: "Item",
    amount: "Amount",
    keepRecurring: "recurring",
    carryButton: "Carry selected ({n})",
    carryDone: "Carried: {added}, skipped (already there): {skipped}",
    total: "All teams",
    cancel: "Cancel",
  },
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""))

export function TeamsPanel(props: {
  locale: Locale
  monthKey: string
  baseCurrency: string
  ledger: Ledger
  payrollByTeam: Record<string, string>
  employees: { employeeId: string; name: string; departmentId: string | null; teamId: string | null }[]
  canManage: boolean
  editable: boolean
  onError: (message: string | null) => void
  onDone: () => void
}) {
  const t = T[props.locale]
  const { ledger } = props
  const money = (v: Decimal | string) => formatAmount(new Decimal(v).toString(), props.baseCurrency, props.locale)
  const [name, setName] = useState("")
  const influence = ledger.departments.find((d) => /influ/i.test(d.name))
  const [departmentId, setDepartmentId] = useState(influence?.id ?? ledger.departments[0]?.id ?? "")
  const [busy, setBusy] = useState<string | null>(null)
  const [carry, setCarry] = useState(false)

  const teams = ledger.departments.flatMap((d) => d.teams.map((team) => ({ ...team, departmentId: d.id, departmentName: d.name })))
  const rows = useMemo(
    () =>
      teams.map((team) => {
        const sum = (list: Ledger["income"] | Ledger["costs"], confirmed: boolean) => list.filter((r) => r.teamId === team.id && r.confirmed === confirmed).reduce((a, r) => a.add(r.baseAmount), new Decimal(0))
        const revenue = sum(ledger.income, true)
        const costs = sum(ledger.costs, true)
        const payroll = new Decimal(props.payrollByTeam[team.id] ?? 0)
        const gross = revenue.sub(costs).sub(payroll)
        return { ...team, revenue, costs, payroll, gross, pending: sum(ledger.income, false).add(sum(ledger.costs, false)) }
      }),
    [teams, ledger.income, ledger.costs, props.payrollByTeam],
  )

  async function run(key: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!r.ok) return props.onError(r.message ?? "Error")
    props.onDone()
  }

  const manage = props.canManage && props.editable

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="font-display text-2xl font-black uppercase italic">{t.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
        </div>
        {manage && (
          <Button size="sm" variant="outline" onClick={() => setCarry(true)}>
            <Copy /> {t.carry}
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl ring-1 ring-foreground/10">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>{[t.team, t.revenue, t.costs, t.payroll, t.gross, t.margin, t.members, ""].map((h, i) => <th key={i} className={cn("px-3 py-2.5 font-medium", i > 0 && i < 6 ? "text-right" : "text-left")}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">{t.noTeams}</td></tr>}
            {rows.map((r, index) => {
              const members = props.employees.filter((e) => e.teamId === r.id)
              const candidates = props.employees.filter((e) => e.departmentId === r.departmentId && e.teamId !== r.id)
              return (
                <tr key={r.id} className="border-t border-border/60 align-top">
                  <td className="px-3 py-2.5">
                    <p className="font-semibold">{r.name}</p>
                    <p className="text-[11px] text-muted-foreground">{r.departmentName}</p>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{money(r.revenue)}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{money(r.costs)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{money(r.payroll)}</td>
                  <td className={cn("px-3 py-2.5 text-right font-mono font-semibold", r.gross.isNegative() && "text-red-300")}>
                    {money(r.gross)}
                    {!r.pending.isZero() && <span className="block text-[10px] font-normal text-muted-foreground">{money(r.pending)} {t.unconfirmed}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{r.revenue.isZero() ? "—" : `${r.gross.div(r.revenue).mul(100).toFixed(1)}%`}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <div className="flex flex-wrap gap-1">
                      {members.map((m) => (
                        <span key={m.employeeId} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5">
                          {m.name}
                          {manage && <button type="button" aria-label="×" className="text-muted-foreground hover:text-red-300" onClick={() => run(`m-${m.employeeId}`, () => setEmployeeTeamAction(props.monthKey, m.employeeId, null))}>×</button>}
                        </span>
                      ))}
                    </div>
                    {manage && candidates.length > 0 && (
                      <Select value="" onChange={(e) => e.target.value && run(`m-${e.target.value}`, () => setEmployeeTeamAction(props.monthKey, e.target.value, r.id))} className="mt-1 h-7 w-40 text-xs" aria-label={t.addMember}>
                        <option value="">{t.addMember}</option>
                        {candidates.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.name}</option>)}
                      </Select>
                    )}
                  </td>
                  <td className="px-2 py-2.5 whitespace-nowrap">
                    {manage && (
                      <span className="flex gap-1">
                        <button type="button" title={t.rename} className="rounded p-1 text-muted-foreground hover:text-primary" onClick={() => { const next = window.prompt(t.name, r.name); if (next && next.trim() !== r.name) run(r.id, () => updateTeamAction(r.id, { name: next })) }}><Pencil className="size-3.5" /></button>
                        <button type="button" title="↑" disabled={index === 0} className="rounded p-1 text-muted-foreground hover:text-primary disabled:opacity-30" onClick={() => run(r.id, () => updateTeamAction(r.id, { move: "up" }))}><ArrowUp className="size-3.5" /></button>
                        <button type="button" title="↓" className="rounded p-1 text-muted-foreground hover:text-primary" onClick={() => run(r.id, () => updateTeamAction(r.id, { move: "down" }))}><ArrowDown className="size-3.5" /></button>
                        <button type="button" title={t.archive} className="rounded p-1 text-muted-foreground hover:text-red-300" onClick={() => window.confirm(`${t.archive}: ${r.name}?`) && run(r.id, () => updateTeamAction(r.id, { archived: true }))}><Archive className="size-3.5" /></button>
                        {busy === r.id && <Loader2 className="size-3.5 animate-spin" />}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-primary/40 font-semibold">
                <td className="px-3 py-2.5">{t.total}</td>
                {(["revenue", "costs", "payroll", "gross"] as const).map((k) => <td key={k} className="px-3 py-2.5 text-right font-mono">{money(rows.reduce((a, r) => a.add(r[k]), new Decimal(0)))}</td>)}
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {manage && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || !departmentId) return
            run("add", () => createTeamAction(departmentId, name)).then(() => setName(""))
          }}
        >
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">{t.name}<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="h-8 w-56" placeholder="Команда Саня" /></label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">{t.department}<Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-8 w-48">{ledger.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></label>
          <Button size="sm" type="submit" disabled={!name.trim() || busy === "add"}>{busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />} {t.add}</Button>
        </form>
      )}

      {carry && <CarryCostsDialog t={t} locale={props.locale} monthKey={props.monthKey} ledger={ledger} onClose={() => setCarry(false)} onDone={(message) => { setCarry(false); props.onError(null); window.alert(message); props.onDone() }} onError={props.onError} />}
    </section>
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
