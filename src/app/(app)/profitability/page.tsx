import type { Metadata } from "next"
import { Suspense } from "react"
import { cn } from "cn"

import { BarChart, ChartLabels } from "@/components/reports/charts"
import { InfoTip } from "@/components/reports/info"
import { ReportHeader } from "@/components/reports/report-header"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { requirePageAccess } from "@/lib/auth/session"
import { formatAmount } from "@/lib/i18n/format"
import { reportTexts } from "@/lib/i18n/reports"
import { getDictionary } from "@/lib/i18n/server"
import { accountActivity, departmentPnl, monthlySeries } from "@/lib/reports/ledger"
import { currentRange, previous, range, rangeLabel, type Range } from "@/lib/reports/periods"
import { reportParams } from "@/lib/reports/params"
import { buildPnl, growth, type Pnl } from "@/lib/reports/statements"
import { prisma } from "@/lib/db"

export const metadata: Metadata = { title: "Прибыльность" }

export default function ProfitabilityPage({ searchParams }: PageProps<"/profitability">) {
  return (
    <Suspense fallback={<PageSkeleton title="Прибыльность" />}>
      <Profitability searchParams={searchParams} />
    </Suspense>
  )
}

const MONTHS = { ru: ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"], en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] }

async function Profitability({ searchParams }: { searchParams: PageProps<"/profitability">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = reportTexts[locale]
  const { range: selected, period } = reportParams(await searchParams, "quarter")
  const thisMonth = currentRange("month")
  const lastMonth = previous(thisMonth)
  const ytd: Range = { ...range("year", thisMonth.year), to: thisMonth.to }
  const load = async (r: Range) => buildPnl(await accountActivity(prisma, user.organizationId, r.from, r.to))
  const [cur, prev, sel, selPrev, year, series, departments] = await Promise.all([
    load(thisMonth),
    load(lastMonth),
    load(selected),
    load(previous(selected)),
    load(ytd),
    monthlySeries(user, thisMonth.year),
    departmentPnl(user, selected),
  ])
  const money = (v: string) => formatAmount(v, user.baseCurrency, locale, { decimals: 0 })
  const pct = (v: string | null) => (v === null ? "—" : `${v}%`)

  const metrics: { key: keyof typeof t.metrics; value: (p: Pnl) => string; percent?: boolean }[] = [
    { key: "revenue", value: (p) => p.revenue },
    { key: "grossProfit", value: (p) => p.grossProfit },
    { key: "grossMargin", value: (p) => p.margins.gross ?? "", percent: true },
    { key: "ebitda", value: (p) => p.ebitda },
    { key: "ebitdaMargin", value: (p) => p.margins.ebitda ?? "", percent: true },
    { key: "ebit", value: (p) => p.ebit },
    { key: "ebitMargin", value: (p) => p.margins.ebit ?? "", percent: true },
    { key: "operatingProfit", value: (p) => p.ebit },
    { key: "profitBeforeTax", value: (p) => p.profitBeforeTax },
    { key: "netProfit", value: (p) => p.netProfit },
    { key: "netMargin", value: (p) => p.margins.net ?? "", percent: true },
    { key: "totalExpenses", value: (p) => p.totalExpenses },
  ]
  const columns: { label: string; pnl: Pnl; compare?: Pnl }[] = [
    { label: `${t.analytics.current} · ${rangeLabel(thisMonth, locale)}`, pnl: cur, compare: prev },
    { label: `${t.analytics.previous} · ${rangeLabel(lastMonth, locale)}`, pnl: prev },
    { label: rangeLabel(selected, locale), pnl: sel, compare: selPrev },
    { label: `${t.analytics.yearToDate} ${thisMonth.year}`, pnl: year },
  ]
  const growthRows = [
    { key: "revenueGrowth" as const, get: (a: Pnl, b: Pnl) => growth(a.revenue, b.revenue) },
    { key: "expenseGrowth" as const, get: (a: Pnl, b: Pnl) => growth(a.totalExpenses, b.totalExpenses) },
    { key: "profitGrowth" as const, get: (a: Pnl, b: Pnl) => growth(a.netProfit, b.netProfit) },
  ]
  const labels = MONTHS[locale]

  return (
    <div className="flex flex-col gap-8">
      <ReportHeader title={t.analytics.profitabilityTitle} description={t.analytics.profitabilityDescription} period={period} kinds={["month", "quarter", "year"]} />

      <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium" />
              {columns.map((c) => <th key={c.label} className="px-4 py-2.5 text-right font-medium">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.key} className={cn("border-t border-border/50", ["ebitda", "ebit", "netProfit"].includes(m.key) && "bg-white/[0.02] font-semibold")}>
                <td className="px-4 py-2"><span className="mr-1.5">{t.metrics[m.key][0]}</span><InfoTip text={t.metrics[m.key][1]} /></td>
                {columns.map((c) => {
                  const v = m.value(c.pnl)
                  return <td key={c.label} className={cn("px-4 py-2 text-right font-mono", !m.percent && Number(v) < 0 && "text-red-300")}>{m.percent ? pct(v || null) : money(v)}</td>
                })}
              </tr>
            ))}
            {growthRows.map((g) => (
              <tr key={g.key} className="border-t border-border/50 text-muted-foreground">
                <td className="px-4 py-2"><span className="mr-1.5">{t.metrics[g.key][0]}</span><InfoTip text={t.metrics[g.key][1]} /></td>
                {columns.map((c) => {
                  const v = c.compare ? g.get(c.pnl, c.compare) : null
                  return <td key={c.label} className={cn("px-4 py-2 text-right font-mono", v !== null && (Number(v) >= 0 ? "text-emerald-300/90" : "text-red-300/90"))}>{pct(v)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {(["ebitda", "ebit", "netProfit"] as const).map((k) => (
          <div key={k} className="rounded-2xl border border-border bg-card/60 p-5">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.metrics[k][0]} · {t.analytics.trend} {thisMonth.year}</p>
            <BarChart data={series.map((s, i) => ({ label: labels[i], value: Number(s.pnl[k]) }))} />
            <ChartLabels labels={labels} />
          </div>
        ))}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-black uppercase italic">{t.analytics.byDepartment} · {rangeLabel(selected, locale)}</h2>
        <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <tr>
                {["", t.metrics.revenue[0], t.metrics.grossProfit[0], t.metrics.ebitda[0], t.metrics.netProfit[0], t.metrics.netMargin[0]].map((h, i) => <th key={i} className={cn("px-4 py-2.5 font-medium", i ? "text-right" : "text-left")}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {departments.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">{t.pnl.empty}</td></tr>}
              {departments.map((d) => (
                <tr key={d.id} className="border-t border-border/50">
                  <td className="px-4 py-2">{d.name}</td>
                  <td className="px-4 py-2 text-right font-mono">{money(d.pnl.revenue)}</td>
                  <td className="px-4 py-2 text-right font-mono">{money(d.pnl.grossProfit)}</td>
                  <td className="px-4 py-2 text-right font-mono">{money(d.pnl.ebitda)}</td>
                  <td className={cn("px-4 py-2 text-right font-mono font-semibold", Number(d.pnl.netProfit) < 0 && "text-red-300")}>{money(d.pnl.netProfit)}</td>
                  <td className="px-4 py-2 text-right font-mono text-muted-foreground">{pct(d.pnl.margins.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          {locale === "ru"
            ? "По отделам: доходы и расходы с указанным отделом в проводках (ФОТ, проекты, транзакции). Общие расходы без отдела в разбивку не входят."
            : "By department: income and costs tagged with the department in the ledger (payroll, projects, transactions). Shared costs without a department are not allocated."}
        </p>
      </section>
    </div>
  )
}
