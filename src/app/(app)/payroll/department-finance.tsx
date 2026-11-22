"use client"

import Decimal from "decimal.js"
import { Check, Loader2, Plus, Repeat } from "lucide-react"
import { useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { getProjectLedger } from "@/lib/data/project-ledger"
import { dictionaries, type Dictionary } from "@/lib/i18n/dictionaries"
import { formatAmount, formatDate, normalizeNumber, type Locale } from "@/lib/i18n/format"

import { addLedgerAction, confirmLedgerAction, createLedgerCategoryAction, updateLedgerAction, type LedgerFormInput } from "./actions"
import { RowDialog } from "./project-ledger"
import { CarryCostsButton } from "./recurring-costs"

type Ledger = Awaited<ReturnType<typeof getProjectLedger>>
type Income = Ledger["income"][number]
type Cost = Ledger["costs"][number]
type Row = Income | Cost
type BlockKind = "recurring" | "oneTime" | "income"

const T = {
  ru: {
    recurring: "Постоянные расходы",
    recurringHint: "Ежемесячные расходы отдела: инструменты, подписки, инфраструктура, постоянные подрядчики. Переносятся в следующий месяц как план; в P&L попадают после подтверждения (✓), в Cash Flow — после оплаты.",
    oneTime: "Дополнительные расходы",
    oneTimeHint: "Разовые расходы отдела этого месяца.",
    income: "Доходы",
    incomeHint: "Доходы отдела этого месяца. В выручку попадают после подтверждения (✓); в следующий месяц не копируются.",
    profit: "Прибыльность отдела",
    profitHint: "Только подтверждённые доходы и расходы. Зарплата берётся из таблицы сотрудников выше (утверждённая или расчётная) и учитывается один раз. PROFIT сотрудников — показатель KPI, он не добавляется к выручке.",
    name: "Название",
    amount: "Сумма",
    currency: "Валюта",
    category: "Категория",
    newCategory: "+ новая категория…",
    date: "Дата",
    comment: "Комментарий",
    client: "Клиент / рекламодатель",
    project: "Проект",
    add: "Добавить",
    total: "Итого",
    confirmedTotal: "подтверждено",
    empty: "Пока нет записей.",
    revenue: "Признанная выручка",
    direct: "Прямые расходы",
    payroll: "Зарплаты отдела",
    contribution: "Прибыль отдела (вклад)",
    margin: "Маржа",
    pending: "Ещё не подтверждено: доходы {income}, расходы {costs}",
    stopRecurring: "Сделать разовым",
    makeRecurring: "Сделать постоянным",
    confirm: "Подтвердить (учесть в отчётах)",
  },
  en: {
    recurring: "Recurring costs",
    recurringHint: "The department's monthly costs: tools, subscriptions, infrastructure, recurring contractors. Carried to the next month as plans; reach the P&L when confirmed (✓) and Cash Flow when paid.",
    oneTime: "Additional costs",
    oneTimeHint: "One-time costs of the department this month.",
    income: "Income",
    incomeHint: "The department's income this month. Counted as revenue when confirmed (✓); never copied to the next month.",
    profit: "Department profitability",
    profitHint: "Confirmed income and costs only. Payroll comes from the employee table above (approved or calculated) and is counted once. Employees' PROFIT is a KPI figure and never adds to revenue.",
    name: "Name",
    amount: "Amount",
    currency: "Currency",
    category: "Category",
    newCategory: "+ new category…",
    date: "Date",
    comment: "Comment",
    client: "Client / advertiser",
    project: "Project",
    add: "Add",
    total: "Total",
    confirmedTotal: "confirmed",
    empty: "No entries yet.",
    revenue: "Recognized revenue",
    direct: "Direct costs",
    payroll: "Department payroll",
    contribution: "Department profit (contribution)",
    margin: "Margin",
    pending: "Not confirmed yet: income {income}, costs {costs}",
    stopRecurring: "Make one-time",
    makeRecurring: "Make recurring",
    confirm: "Confirm (count in reports)",
  },
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "")
const CURRENCIES = ["USD", "USDT", "EUR", "GBP"] as const

/** One department's recurring costs, additional costs, income and profitability for the month. */
export function DepartmentFinance(props: {
  locale: Locale
  monthKey: string
  baseCurrency: string
  departmentId: string
  ledger: Ledger
  payroll: string
  accounts: { id: string; name: string; currency: string }[]
  editable: boolean
  canCategories: boolean
  onRefresh: () => void
}) {
  const t = T[props.locale]
  const dict = dictionaries[props.locale] as Dictionary
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Row | null>(null)
  const money = (v: Decimal | string) => formatAmount(new Decimal(v).toString(), props.baseCurrency, props.locale)
  const department = props.ledger.departments.find((d) => d.id === props.departmentId)
  const costs = props.ledger.costs.filter((c) => c.departmentId === props.departmentId)
  const income = props.ledger.income.filter((c) => c.departmentId === props.departmentId)
  const sum = (rows: Row[], confirmed?: boolean) => rows.filter((r) => confirmed === undefined || r.confirmed === confirmed).reduce((a, r) => a.add(r.baseAmount), new Decimal(0))
  const revenue = sum(income, true)
  const direct = sum(costs, true)
  const payroll = new Decimal(props.payroll || 0)
  const contribution = revenue.sub(direct).sub(payroll)
  const done = () => {
    setError(null)
    props.onRefresh()
  }

  const blocks: { kind: BlockKind; title: string; hint: string; rows: Row[] }[] = [
    { kind: "recurring", title: t.recurring, hint: t.recurringHint, rows: costs.filter((c) => c.recurring) },
    { kind: "oneTime", title: t.oneTime, hint: t.oneTimeHint, rows: costs.filter((c) => !c.recurring) },
    { kind: "income", title: t.income, hint: t.incomeHint, rows: income },
  ]

  return (
    <div className="mt-10 flex flex-col gap-6">
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">{error}</p>}
      <div className="grid gap-5 xl:grid-cols-3">
        {blocks.map((b) => (
          <Block
            key={b.kind}
            {...props}
            t={t}
            kind={b.kind}
            title={b.title}
            hint={b.hint}
            rows={b.rows}
            money={money}
            onEdit={setEditing}
            onError={setError}
            onDone={done}
            extra={b.kind === "recurring" && props.editable ? <CarryCostsButton locale={props.locale} monthKey={props.monthKey} ledger={props.ledger} departmentId={props.departmentId} onDone={done} onError={setError} /> : null}
          />
        ))}
      </div>

      <section className="rounded-2xl border border-primary/40 bg-[#1d0b17] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{t.profit}{department ? ` · ${department.name}` : ""}</p>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{t.profitHint}</p>
        <div className="mt-4 grid gap-3 font-mono text-sm sm:grid-cols-[1fr_auto] sm:gap-x-10">
          <span className="font-sans text-muted-foreground">{t.revenue}</span><span className="text-right">{money(revenue)}</span>
          <span className="font-sans text-muted-foreground">− {t.direct}</span><span className="text-right">{money(direct)}</span>
          <span className="font-sans text-muted-foreground">− {t.payroll}</span><span className="text-right">{money(payroll)}</span>
          <span className="border-t border-primary/40 pt-2 font-display font-black uppercase italic">= {t.contribution}</span>
          <span className={cn("border-t border-primary/40 pt-2 text-right text-lg font-semibold", contribution.isNegative() && "text-red-300")}>{money(contribution)}</span>
          <span className="font-sans text-muted-foreground">{t.margin}</span><span className="text-right text-muted-foreground">{revenue.isZero() ? "—" : `${contribution.div(revenue).mul(100).toFixed(1)}%`}</span>
        </div>
        {(!sum(income, false).isZero() || !sum(costs, false).isZero()) && (
          <p className="mt-3 text-[11px] text-amber-300">{fill(t.pending, { income: money(sum(income, false)), costs: money(sum(costs, false)) })}</p>
        )}
      </section>

      {editing && <RowDialog row={editing} ledger={props.ledger} accounts={props.accounts} editable={props.editable} locale={props.locale} t={dict} onClose={() => setEditing(null)} onDone={() => { setEditing(null); done() }} />}
    </div>
  )
}

function Block(props: {
  locale: Locale
  monthKey: string
  departmentId: string
  ledger: Ledger
  editable: boolean
  canCategories: boolean
  t: (typeof T)["ru"]
  kind: BlockKind
  title: string
  hint: string
  rows: Row[]
  money: (v: Decimal | string) => string
  extra: React.ReactNode
  onEdit: (row: Row) => void
  onError: (m: string | null) => void
  onDone: () => void
}) {
  const { t, kind } = props
  const ledgerKind = kind === "income" ? "income" : "cost"
  const empty = { item: "", amount: "", currency: "USD", categoryId: "", date: "", notes: "", clientName: "", projectId: "" }
  const [form, setForm] = useState(empty)
  const [busy, setBusy] = useState<string | null>(null)
  const categories = props.ledger.categories.filter((c) => c.kind === ledgerKind)
  const projects = props.ledger.projects.filter((p) => !p.departmentId || p.departmentId === props.departmentId)
  const total = props.rows.reduce((a, r) => a.add(r.baseAmount), new Decimal(0))
  const confirmed = props.rows.filter((r) => r.confirmed).reduce((a, r) => a.add(r.baseAmount), new Decimal(0))

  async function run(key: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!r.ok) {
      props.onError(r.message ?? "Error")
      return false
    }
    props.onDone()
    return true
  }

  async function add(allowDuplicate = false) {
    const amount = normalizeNumber(form.amount)
    if (!form.item.trim() || !amount) return props.onError(props.locale === "ru" ? "Укажите название и сумму (например 3500 или 25750.50)." : "Enter a name and an amount.")
    if (Number(amount) <= 0) return props.onError(props.locale === "ru" ? "Сумма должна быть больше нуля." : "Amount must be greater than zero.")
    const input: LedgerFormInput = { departmentId: props.departmentId, item: form.item, amount, currency: form.currency, categoryId: form.categoryId, projectId: form.projectId, clientId: "", clientName: kind === "income" ? form.clientName : "", teamId: "", date: form.date, notes: form.notes, recurring: kind === "recurring" ? "true" : "false" }
    setBusy("add")
    const r = await addLedgerAction(props.monthKey, ledgerKind, input, allowDuplicate)
    setBusy(null)
    if (!r.ok) {
      if ("duplicate" in r && r.duplicate && window.confirm(props.locale === "ru" ? "Такая строка с той же суммой уже есть в этом месяце. Добавить ещё одну?" : "Same item and amount already exist this month. Add anyway?")) return add(true)
      return props.onError(r.message)
    }
    setForm({ ...empty, currency: form.currency, categoryId: form.categoryId })
    props.onDone()
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-card/60 p-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-black uppercase italic">{props.title}</h3>
          <p className="text-[11px] text-muted-foreground">{props.hint}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-semibold">{props.money(total)}</p>
          <p className="text-[10px] text-muted-foreground">{t.confirmedTotal}: {props.money(confirmed)}</p>
        </div>
      </div>
      {props.extra}
      <ul className="flex flex-col divide-y divide-border/40 text-[13px]">
        {props.rows.length === 0 && <li className="py-3 text-muted-foreground">{t.empty}</li>}
        {props.rows.map((r) => (
          <li key={r.id} className={cn("flex items-center gap-2 py-1.5", !r.confirmed && "text-foreground/75")}>
            <button type="button" onClick={() => props.onEdit(r)} className="min-w-0 flex-1 text-left hover:text-primary" title={[r.categoryName, r.clientName, r.notes].filter(Boolean).join(" · ")}>
              <span className="block truncate">{r.item}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{[r.categoryName, r.clientName, formatDate(r.date, props.locale)].filter(Boolean).join(" · ")}</span>
            </button>
            <span className="font-mono whitespace-nowrap">{formatAmount(r.amount, r.currency, props.locale)}</span>
            {kind !== "income" && props.editable && (
              <button
                type="button"
                title={kind === "recurring" ? t.stopRecurring : t.makeRecurring}
                aria-label={kind === "recurring" ? t.stopRecurring : t.makeRecurring}
                disabled={busy === `r-${r.id}`}
                onClick={() => run(`r-${r.id}`, () => updateLedgerAction("cost", r.id, { recurring: kind === "recurring" ? "false" : "true" }))}
                className={cn("rounded p-1", kind === "recurring" ? "text-primary hover:text-muted-foreground" : "text-muted-foreground hover:text-primary")}
              >
                <Repeat className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              disabled={!props.editable || busy === r.id}
              onClick={() => run(r.id, () => confirmLedgerAction(ledgerKind, r.id, !r.confirmed))}
              aria-pressed={r.confirmed}
              title={t.confirm}
              aria-label={t.confirm}
              className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded border", r.confirmed ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50", busy === r.id && "animate-pulse")}
            >
              {r.confirmed && <Check className="size-3.5" />}
            </button>
          </li>
        ))}
      </ul>
      {props.editable && (
        <form className="grid grid-cols-2 gap-2 border-t border-border/40 pt-3" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <Input value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} placeholder={t.name} maxLength={200} className="col-span-2 h-8" aria-label={t.name} />
          <Input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} inputMode="decimal" placeholder={`${t.amount}: 25750.50`} className="h-8 font-mono" aria-label={t.amount} />
          <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="h-8" aria-label={t.currency}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          <Select
            value={form.categoryId}
            onChange={async (e) => {
              if (e.target.value !== "__new") return setForm({ ...form, categoryId: e.target.value })
              const name = window.prompt(t.newCategory.replace(/[+…]/g, "").trim())?.trim()
              if (name) await run("cat", () => createLedgerCategoryAction(ledgerKind, name))
            }}
            className="col-span-2 h-8"
            aria-label={t.category}
          >
            <option value="">{t.category}: —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {props.canCategories && <option value="__new">{t.newCategory}</option>}
          </Select>
          {kind === "income" && <Input value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder={t.client} maxLength={160} className="h-8" aria-label={t.client} />}
          {projects.length > 0 && (
            <Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} className={cn("h-8", kind !== "income" && "col-span-2")} aria-label={t.project}>
              <option value="">{t.project}: —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="h-8" aria-label={t.date} />
          <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={t.comment} maxLength={2000} className="h-8" aria-label={t.comment} />
          <Button type="submit" size="sm" className="col-span-2" disabled={busy === "add"}>{busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />} {t.add}</Button>
        </form>
      )}
    </section>
  )
}
