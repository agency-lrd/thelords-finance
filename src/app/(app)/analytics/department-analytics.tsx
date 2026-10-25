import { cn } from "cn"

import { PeriodPicker } from "@/components/reports/period-picker"
import { formatAmount, type Locale } from "@/lib/i18n/format"
import type { departmentAnalytics } from "@/lib/reports/analytics"

type Data = Awaited<ReturnType<typeof departmentAnalytics>>
type Figures = Data["departments"][number]["current"]

const T = {
  ru: {
    title: "Отделы и команды за месяц",
    hint: "Из проводок: выручка, прямые расходы (включая зарплаты проектных отделов), зарплаты и валовая прибыль; рядом изменение к прошлому месяцу. Команды — часть своих отделов: их зарплаты уже входят в цифры отдела, ничего не считается дважды.",
    departments: "Отделы",
    teams: "Команды",
    name: "Название",
    revenue: "Выручка",
    direct: "Прямые расходы",
    payroll: "Зарплаты",
    gross: "Валовая прибыль",
    margin: "Маржа",
    change: "к прошлому мес.",
    empty: "Нет данных за этот месяц.",
  },
  en: {
    title: "Departments and teams for the month",
    hint: "From the ledger: revenue, direct costs (including delivery payroll), payroll and gross profit, with the change from last month. Teams are part of their departments: their payroll is already in the department figures, nothing counts twice.",
    departments: "Departments",
    teams: "Teams",
    name: "Name",
    revenue: "Revenue",
    direct: "Direct costs",
    payroll: "Payroll",
    gross: "Gross profit",
    margin: "Margin",
    change: "vs last month",
    empty: "No data for this month.",
  },
}

export function DepartmentAnalytics({ locale, currency, data }: { locale: Locale; currency: string; data: Data }) {
  const t = T[locale]
  const money = (v: string) => formatAmount(v, currency, locale)
  const change = (cur: string, prev: string) => {
    const a = Number(cur)
    const b = Number(prev)
    if (!b) return null
    return ((a - b) / Math.abs(b)) * 100
  }
  const table = (title: string, rows: { id: string; name: string; sub?: string; current: Figures; previous: Figures }[]) => (
    <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          <tr>{[title, t.revenue, t.direct, t.payroll, t.gross, t.margin].map((h, i) => <th key={h} className={cn("px-3 py-2.5 font-medium", i ? "text-right" : "text-left")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">{t.empty}</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border/60">
              <td className="px-3 py-2">{r.name}{r.sub && <span className="block text-[11px] text-muted-foreground">{r.sub}</span>}</td>
              {(["revenue", "direct", "payroll", "gross"] as const).map((k) => {
                const c = change(r.current[k], r.previous[k])
                return (
                  <td key={k} className="px-3 py-2 text-right font-mono">
                    <span className={cn(k === "gross" && Number(r.current[k]) < 0 && "text-red-300")}>{money(r.current[k])}</span>
                    {c !== null && <span className={cn("block text-[10px]", (k === "revenue" || k === "gross" ? c >= 0 : c <= 0) ? "text-emerald-300/80" : "text-red-300/80")} title={t.change}>{c >= 0 ? "+" : ""}{c.toFixed(1)}%</span>}
                  </td>
                )
              })}
              <td className="px-3 py-2 text-right font-mono text-muted-foreground">{r.current.margin === null ? "—" : `${r.current.margin}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="font-display text-2xl font-black uppercase italic">{t.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
        </div>
        <PeriodPicker value={data.month} kinds={["month"]} param="m" />
      </div>
      {table(t.departments, data.departments)}
      {data.teams.length > 0 && table(t.teams, data.teams.map((x) => ({ ...x, sub: x.department })))}
    </section>
  )
}
