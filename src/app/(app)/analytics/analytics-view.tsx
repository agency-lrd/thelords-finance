"use client"

import Decimal from "decimal.js"
import { Download, Plus } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { BarChart, ChartLabels, LineChart, ShareBars } from "@/components/reports/charts"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { monthlyAnalytics } from "@/lib/reports/analytics"
import { formatAmount, type Locale } from "@/lib/i18n/format"
import { reportTexts } from "@/lib/i18n/reports"
import { toCsv, writeXlsx } from "@/lib/xlsx"

import { addMetricAction, setKpiAction } from "./actions"

type Data = Awaited<ReturnType<typeof monthlyAnalytics>>
type Month = Data["months"][number]
type Agg = "sum" | "last" | "avg"
type RowDef = { key: string; label: string; get: (m: Month) => string | number | null; kind: "money" | "count" | "percent" | "number"; agg: Agg; manual?: string }

const MONTHS = { ru: ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"], en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] }

export function AnalyticsView(props: {
  locale: Locale
  currency: string
  data: Data
  departments: { name: string; netProfit: string }[]
  costStructure: { name: string; amount: string }[]
  canEdit: boolean
}) {
  const { locale, currency, data } = props
  const t = reportTexts[locale].analytics
  const router = useRouter()
  const [, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ code: string; month: number; value: string } | null>(null)
  const [newMetric, setNewMetric] = useState({ name: "", unit: "COUNT" })
  const months = data.months
  const thisYear = new Date().getUTCFullYear()
  const lastMonth = data.year < thisYear ? 12 : data.year > thisYear ? 0 : new Date().getUTCMonth() + 1

  const definitions = data.definitions
  const rows: RowDef[] = [
    { key: "clients", label: t.clients, get: (m) => m.clients, kind: "count", agg: "last" },
    { key: "newClients", label: t.newClients, get: (m) => m.newClients, kind: "count", agg: "sum" },
    { key: "activeClients", label: t.activeClients, get: (m) => m.activeClients, kind: "count", agg: "avg" },
    { key: "employees", label: t.employees, get: (m) => m.employees, kind: "count", agg: "last" },
    { key: "avgSalary", label: t.avgSalary, get: (m) => m.avgSalary, kind: "money", agg: "avg" },
    { key: "MANAGED_BUDGET", label: t.managedBudget, get: (m) => m.manual.MANAGED_BUDGET ?? null, kind: "money", agg: "sum", manual: "MANAGED_BUDGET" },
    { key: "revenue", label: t.agencyRevenue, get: (m) => m.revenue, kind: "money", agg: "sum" },
    { key: "grossProfit", label: t.grossProfit, get: (m) => m.grossProfit, kind: "money", agg: "sum" },
    { key: "payroll", label: t.payroll, get: (m) => m.payroll, kind: "money", agg: "sum" },
    { key: "marketing", label: t.marketing, get: (m) => m.marketing, kind: "money", agg: "sum" },
    { key: "operatingExpenses", label: t.operational, get: (m) => m.operatingExpenses, kind: "money", agg: "sum" },
    { key: "ebitda", label: t.ebitda, get: (m) => m.ebitda, kind: "money", agg: "sum" },
    { key: "ebit", label: t.ebit, get: (m) => m.ebit, kind: "money", agg: "sum" },
    { key: "netProfit", label: t.netProfit, get: (m) => m.netProfit, kind: "money", agg: "sum" },
    { key: "netMargin", label: t.netMargin, get: (m) => m.netMargin, kind: "percent", agg: "avg" },
    { key: "cashIn", label: t.cashIn, get: (m) => m.cashIn, kind: "money", agg: "sum" },
    { key: "cashOut", label: t.cashOut, get: (m) => m.cashOut, kind: "money", agg: "sum" },
    { key: "closingCash", label: t.closingCash, get: (m) => m.closingCash, kind: "money", agg: "last" },
    ...definitions
      .filter((d) => !d.system)
      .map((d) => ({ key: d.code, label: d.name, get: (m: Month) => m.manual[d.code] ?? null, kind: (d.unit === "CURRENCY" ? "money" : d.unit === "PERCENT" ? "percent" : "number") as RowDef["kind"], agg: "last" as Agg, manual: d.code })),
  ]

  // Months after the current one have no data yet: excluded from averages and "last" values.
  const aggregate = (row: RowDef, list: Month[]) => {
    const values = list.filter((m) => m.month <= lastMonth || row.manual).map(row.get).filter((v): v is string | number => v !== null && v !== undefined)
    if (values.length === 0) return null
    if (row.key === "netMargin") {
      const rev = list.reduce((a, m) => a.add(m.revenue), new Decimal(0))
      return rev.isZero() ? null : list.reduce((a, m) => a.add(m.netProfit), new Decimal(0)).div(rev).mul(100).toDecimalPlaces(1).toString()
    }
    if (row.agg === "last") return String(values[values.length - 1])
    const sum = values.reduce<Decimal>((a, v) => a.add(String(v)), new Decimal(0))
    return row.agg === "sum" ? sum.toString() : sum.div(values.length).toDecimalPlaces(2).toString()
  }
  const format = (row: RowDef, v: string | number | null) => {
    if (v === null || v === undefined || v === "") return "—"
    if (row.kind === "money") return formatAmount(String(v), currency, locale, { decimals: 0 })
    if (row.kind === "percent") return `${v}%`
    return new Decimal(String(v)).toDecimalPlaces(1).toString()
  }
  const quarters = [1, 2, 3, 4].map((q) => months.filter((m) => Math.ceil(m.month / 3) === q))

  async function save() {
    if (!editing) return
    const result = await setKpiAction(editing.code, data.year, editing.month, editing.value)
    setEditing(null)
    if (!result.ok) setError(result.message)
    else startRefresh(() => router.refresh())
  }

  function exportTable(kind: "csv" | "xlsx") {
    const head = [t.row, ...MONTHS[locale], "Q1", "Q2", "Q3", "Q4", t.total]
    const body = rows.map((r) => [r.label, ...months.map((m) => r.get(m) ?? ""), ...quarters.map((q) => aggregate(r, q) ?? ""), aggregate(r, months) ?? ""].map((v) => (v === null ? "" : String(v))))
    const blob = kind === "csv" ? new Blob([toCsv([head, ...body])], { type: "text/csv;charset=utf-8" }) : new Blob([writeXlsx([head, ...body], `Analytics ${data.year}`).slice().buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement("a"), { href: url, download: `analytics-${data.year}.${kind}` }).click()
    URL.revokeObjectURL(url)
  }

  const series = (get: (m: Month) => string | number | null) => months.map((m, i) => ({ label: MONTHS[locale][i], value: Number(get(m) ?? 0) }))
  const labels = MONTHS[locale]

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{t.title} {data.year}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[data.year - 1, data.year + 1].map((y) => (
            <Link key={y} href={`?year=${y}`} className="rounded-full border border-border px-3 py-1 text-sm hover:border-primary/60 hover:text-primary">{y}</Link>
          ))}
          <Button size="sm" variant="ghost" onClick={() => exportTable("csv")}><Download /> CSV</Button>
          <Button size="sm" variant="ghost" onClick={() => exportTable("xlsx")}><Download /> XLSX</Button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">{error}</p>}

      <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <th className="sticky left-0 z-10 bg-[#141015] px-3 py-2.5 text-left font-medium">{t.row}</th>
              {MONTHS[locale].map((m, i) => <th key={m} className={cn("bg-[#141015] px-3 py-2.5 text-right font-medium", i + 1 === lastMonth && data.year === thisYear && "text-primary")}>{m}</th>)}
              {["Q1", "Q2", "Q3", "Q4"].map((q) => <th key={q} className="bg-[#1b1320] px-3 py-2.5 text-right font-medium">{q}</th>)}
              <th className="bg-[#3a0d29] px-3 py-2.5 text-right font-medium text-white">{t.total}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="hover:bg-white/[0.02]">
                <td className="sticky left-0 z-10 border-t border-border/50 bg-[#0f0c10] px-3 py-1.5 whitespace-nowrap">
                  {r.label}
                  {r.manual && <span className="ml-1.5 text-[10px] text-muted-foreground">({t.manual})</span>}
                </td>
                {months.map((m) => {
                  const isEditing = editing?.code === r.manual && editing?.month === m.month
                  return (
                    <td
                      key={m.month}
                      onDoubleClick={() => r.manual && props.canEdit && setEditing({ code: r.manual, month: m.month, value: String(r.get(m) ?? "") })}
                      className={cn("border-t border-border/50 px-3 py-1.5 text-right font-mono whitespace-nowrap", r.manual && props.canEdit && "cursor-text hover:bg-primary/5", m.month > lastMonth && !r.manual && "text-muted-foreground/40", r.kind === "money" && Number(r.get(m)) < 0 && "text-red-300")}
                    >
                      {isEditing ? (
                        <Input
                          autoFocus
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(null) }}
                          onBlur={() => void save()}
                          className="h-7 w-24 text-right font-mono"
                          aria-label={`${r.label} ${m.month}`}
                        />
                      ) : (
                        format(r, r.get(m))
                      )}
                    </td>
                  )
                })}
                {quarters.map((q, i) => <td key={i} className="border-t border-border/50 bg-white/[0.02] px-3 py-1.5 text-right font-mono whitespace-nowrap">{format(r, aggregate(r, q))}</td>)}
                <td className="border-t border-border/50 bg-[#3a0d29]/50 px-3 py-1.5 text-right font-mono font-semibold whitespace-nowrap">{format(r, aggregate(r, months))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            const result = await addMetricAction(newMetric.name, newMetric.unit)
            if (!result.ok) return setError(result.message)
            setNewMetric({ name: "", unit: "COUNT" })
            startRefresh(() => router.refresh())
          }}
        >
          <Input value={newMetric.name} onChange={(e) => setNewMetric((x) => ({ ...x, name: e.target.value }))} placeholder={t.metricName} className="h-8 w-60" maxLength={80} required aria-label={t.metricName} />
          <Select value={newMetric.unit} onChange={(e) => setNewMetric((x) => ({ ...x, unit: e.target.value }))} className="h-8 w-40" aria-label={t.metricUnit}>
            {(["COUNT", "CURRENCY", "PERCENT", "RATIO"] as const).map((u) => <option key={u} value={u}>{t.units[u]}</option>)}
          </Select>
          <Button type="submit" size="sm" variant="outline"><Plus /> {t.addMetric}</Button>
          <span className="text-xs text-muted-foreground">{locale === "ru" ? "Двойной клик по ячейке ручного показателя — ввод значения." : "Double-click a manual metric cell to enter a value."}</span>
        </form>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Chart title={t.charts.clients}><LineChart data={series((m) => m.clients)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.revenue}><BarChart data={series((m) => m.revenue)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.avgSalary}><LineChart data={series((m) => m.avgSalary)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.payroll}><BarChart data={series((m) => m.payroll)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.ebitda}><BarChart data={series((m) => m.ebitda)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.netProfit}><BarChart data={series((m) => m.netProfit)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.cashFlow}><BarChart data={series((m) => m.netCash)} /><ChartLabels labels={labels} /></Chart>
        <Chart title={t.charts.departments}>
          {props.departments.length ? <ShareBars data={props.departments.map((d) => ({ label: d.name, value: Number(d.netProfit) }))} format={(v) => formatAmount(String(v), currency, locale, { decimals: 0 })} /> : <p className="text-sm text-muted-foreground">—</p>}
        </Chart>
        <Chart title={t.charts.costStructure}>
          {props.costStructure.length ? <ShareBars data={props.costStructure.slice(0, 8).map((c) => ({ label: c.name, value: Number(c.amount) }))} format={(v) => formatAmount(String(v), currency, locale, { decimals: 0 })} /> : <p className="text-sm text-muted-foreground">—</p>}
        </Chart>
      </div>
    </div>
  )
}

function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-5">
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}
