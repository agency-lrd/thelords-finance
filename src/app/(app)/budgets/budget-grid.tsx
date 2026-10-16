"use client"

import Decimal from "decimal.js"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { Input } from "@/components/ui/form-controls"
import { formatAmount, type Locale } from "@/lib/i18n/format"

import { setBudgetAction } from "./actions"

const MONTHS = { ru: ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"], en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] }
export const METRICS = ["REVENUE", "DIRECT_COSTS", "OPEX", "PAYROLL", "MARKETING", "EBITDA", "NET_PROFIT", "CASH_RESERVE"] as const
type Metric = (typeof METRICS)[number]
const COST_METRICS: Metric[] = ["DIRECT_COSTS", "OPEX", "PAYROLL", "MARKETING"]

const T = {
  ru: {
    title: "Бюджеты и прогнозы",
    description: "Помесячные бюджеты, цели и сценарии. Плановые цифры всегда показываются отдельно от факта из бухгалтерии. Двойной клик по ячейке — ввод.",
    scenario: { BASE: "Базовый", CONSERVATIVE: "Консервативный", AGGRESSIVE: "Агрессивный" },
    scope: "Область",
    company: "Вся компания",
    metric: { REVENUE: "Выручка (цель)", DIRECT_COSTS: "Себестоимость", OPEX: "Операционные расходы", PAYROLL: "ФОТ", MARKETING: "Маркетинг", EBITDA: "EBITDA", NET_PROFIT: "Чистая прибыль (цель)", CASH_RESERVE: "Резерв денег (минимум)" },
    budget: "План",
    actual: "Факт",
    variance: "Откл.",
    variancePct: "Откл. %",
    year: "Год",
    forecastNote: "Консервативный и агрессивный сценарии — прогнозы для Cash Flow, не факт.",
  },
  en: {
    title: "Budgets and forecasts",
    description: "Monthly budgets, targets and scenarios. Planned numbers are always shown apart from actual ledger results. Double-click a cell to enter a value.",
    scenario: { BASE: "Base", CONSERVATIVE: "Conservative", AGGRESSIVE: "Aggressive" },
    scope: "Scope",
    company: "Whole company",
    metric: { REVENUE: "Revenue (target)", DIRECT_COSTS: "Cost of services", OPEX: "Operating expenses", PAYROLL: "Payroll", MARKETING: "Marketing", EBITDA: "EBITDA", NET_PROFIT: "Net profit (target)", CASH_RESERVE: "Cash reserve (minimum)" },
    budget: "Budget",
    actual: "Actual",
    variance: "Var.",
    variancePct: "Var. %",
    year: "Year",
    forecastNote: "Conservative and aggressive scenarios are forecasts for Cash Flow, not actuals.",
  },
}

export function BudgetGrid(props: {
  locale: Locale
  currency: string
  year: number
  scenario: "BASE" | "CONSERVATIVE" | "AGGRESSIVE"
  scope: { departmentId: string; projectId: string }
  departments: { id: string; name: string }[]
  projects: { id: string; name: string }[]
  budget: Record<string, Record<number, string>>
  actual: Record<string, Record<number, string>> | null
  canEdit: boolean
}) {
  const { locale, year, scenario } = props
  const t = T[locale]
  const router = useRouter()
  const [, start] = useTransition()
  const [editing, setEditing] = useState<{ metric: Metric; month: number; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const money = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : formatAmount(v, props.currency, locale, { decimals: 0 }))
  const href = (patch: Record<string, string | number>) => {
    const q = new URLSearchParams({ year: String(year), scenario, dept: props.scope.departmentId, project: props.scope.projectId, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) })
    for (const [k, v] of [...q.entries()]) if (!v) q.delete(k)
    return `?${q.toString()}`
  }
  async function save() {
    if (!editing) return
    const r = await setBudgetAction({ year, month: editing.month, scenario, metric: editing.metric, departmentId: props.scope.departmentId, projectId: props.scope.projectId, value: editing.value })
    setEditing(null)
    if (!r.ok) setError(r.message)
    else start(() => router.refresh())
  }
  const yearTotal = (row: Record<number, string> | undefined, metric: Metric) => {
    if (!row) return null
    const values = Object.values(row)
    if (!values.length) return null
    if (metric === "CASH_RESERVE") return row[Math.max(...Object.keys(row).map(Number))]
    return values.reduce((a, v) => a.add(v), new Decimal(0)).toString()
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{t.title} {year}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(["BASE", "CONSERVATIVE", "AGGRESSIVE"] as const).map((s) => (
          <Link key={s} href={href({ scenario: s })} className={cn("rounded-full border px-3 py-1 text-sm", s === scenario ? "border-primary/70 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{t.scenario[s]}</Link>
        ))}
        <span className="mx-2 h-5 w-px bg-border" />
        <Link href={href({ year: year - 1 })} className="rounded-full border border-border px-3 py-1 text-sm hover:text-primary">{year - 1}</Link>
        <Link href={href({ year: year + 1 })} className="rounded-full border border-border px-3 py-1 text-sm hover:text-primary">{year + 1}</Link>
        <span className="mx-2 h-5 w-px bg-border" />
        <form method="get" className="flex items-center gap-2">
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="scenario" value={scenario} />
          <select name="dept" defaultValue={props.scope.departmentId} className="h-8 rounded-lg border border-input bg-input/20 px-2 text-sm" aria-label={t.scope}>
            <option value="">{t.company}</option>
            {props.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select name="project" defaultValue={props.scope.projectId} className="h-8 rounded-lg border border-input bg-input/20 px-2 text-sm" aria-label="Project">
            <option value="">—</option>
            {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="submit" className="h-8 rounded-lg border border-border px-3 text-sm hover:border-primary/60">→</button>
        </form>
      </div>
      {scenario !== "BASE" && <p className="text-xs text-amber-300/90">{t.forecastNote}</p>}
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">{error}</p>}

      <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <th className="sticky left-0 z-10 bg-[#141015] px-3 py-2.5 text-left font-medium" />
              <th className="bg-[#141015] px-2 py-2.5 text-left font-medium" />
              {MONTHS[locale].map((m) => <th key={m} className="bg-[#141015] px-3 py-2.5 text-right font-medium">{m}</th>)}
              <th className="bg-[#3a0d29] px-3 py-2.5 text-right font-medium text-white">{t.year}</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((metric) => {
              const b = props.budget[metric]
              const a = props.actual?.[metric]
              const lines: { kind: "budget" | "actual" | "variance" | "pct"; label: string }[] = [{ kind: "budget", label: t.budget }]
              if (a) lines.push({ kind: "actual", label: t.actual }, { kind: "variance", label: t.variance }, { kind: "pct", label: t.variancePct })
              return lines.map((line, li) => (
                <tr key={`${metric}-${line.kind}`} className={cn(li === 0 && "border-t-8 border-transparent")}>
                  <td className={cn("sticky left-0 z-10 bg-[#0f0c10] px-3 py-1 whitespace-nowrap", li === 0 ? "border-t border-border/60 font-medium" : "")}>{li === 0 ? t.metric[metric] : ""}</td>
                  <td className={cn("px-2 py-1 text-[11px] whitespace-nowrap text-muted-foreground", li === 0 && "border-t border-border/60")}>{line.label}</td>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
                    const bv = b?.[month]
                    const av = a?.[month]
                    let content: string
                    let tone = ""
                    if (line.kind === "budget") content = money(bv)
                    else if (line.kind === "actual") content = money(av)
                    else if (!bv || av === undefined) content = "—"
                    else {
                      const diff = new Decimal(av).sub(bv)
                      // For costs, spending less than budget is favourable.
                      const good = COST_METRICS.includes(metric) ? diff.lte(0) : diff.gte(0)
                      tone = good ? "text-emerald-300/90" : "text-red-300/90"
                      content = line.kind === "variance" ? money(diff.toString()) : new Decimal(bv).isZero() ? "—" : `${diff.div(new Decimal(bv).abs()).mul(100).toDecimalPlaces(1).toString()}%`
                    }
                    const isEditing = line.kind === "budget" && editing?.metric === metric && editing.month === month
                    return (
                      <td
                        key={month}
                        onDoubleClick={() => line.kind === "budget" && props.canEdit && setEditing({ metric, month, value: bv ?? "" })}
                        className={cn("px-3 py-1 text-right font-mono whitespace-nowrap", li === 0 && "border-t border-border/60", line.kind === "budget" && props.canEdit && "cursor-text hover:bg-primary/5", line.kind !== "budget" && "text-muted-foreground", tone)}
                      >
                        {isEditing ? (
                          <Input autoFocus value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(null) }} onBlur={() => void save()} className="h-7 w-24 text-right font-mono" aria-label={`${t.metric[metric]} ${month}`} />
                        ) : content}
                      </td>
                    )
                  })}
                  <td className={cn("bg-[#3a0d29]/40 px-3 py-1 text-right font-mono whitespace-nowrap", li === 0 && "border-t border-border/60")}>
                    {line.kind === "budget" ? money(yearTotal(b, metric)) : line.kind === "actual" ? money(yearTotal(a, metric)) : ""}
                  </td>
                </tr>
              ))
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
