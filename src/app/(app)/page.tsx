import { ArrowRight, CircleCheck, TriangleAlert } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"
import { cn } from "cn"

import { Greeting } from "@/components/dashboard/greeting"
import { BarChart, ChartLabels, LineChart, ShareBars } from "@/components/reports/charts"
import { InfoTip } from "@/components/reports/info"
import { PeriodPicker } from "@/components/reports/period-picker"
import { can, requireUser } from "@/lib/auth/session"
import { getSheet } from "@/lib/data/sheet"
import { formatAmount, formatDate } from "@/lib/i18n/format"
import { reportTexts } from "@/lib/i18n/reports"
import { getDictionary } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { currentMonth } from "@/lib/period"
import { executiveDashboard } from "@/lib/reports/dashboard"
import { reportParams } from "@/lib/reports/params"
import { rangeLabel } from "@/lib/reports/periods"
import { growth, percent } from "@/lib/reports/statements"

const MONTHS = { ru: ["Я", "Ф", "М", "А", "М", "И", "И", "А", "С", "О", "Н", "Д"], en: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"] }

const T = {
  ru: {
    netProfitPeriod: "Чистая прибыль",
    target: "Цель",
    noTarget: "Цель не задана — добавьте в Бюджетах",
    ofTarget: "от цели",
    left: "осталось",
    vsPrev: "к пред. периоду",
    turnover: "Бюджеты клиентов / оборот",
    revenue: "Выручка агентства",
    expenses: "Все расходы",
    grossProfit: "Валовая прибыль",
    ebitda: "EBITDA",
    ebit: "EBIT",
    netProfit: "Чистая прибыль",
    netMargin: "Маржа чистой прибыли",
    cash: "Остаток денег",
    cashIn: "Получено денег",
    cashInInfo: "Реально поступившие деньги за период (оплаты клиентов, бюджеты, взносы, займы). Не равно выручке.",
    cashOut: "Выплачено денег",
    cashOutInfo: "Реально ушедшие деньги за период: зарплаты, расходы, выплаты собственникам и инвесторам.",
    cashEnd: "Остаток на конец периода",
    payroll: "Обязательства по ФОТ",
    revenueVsExpenses: "Выручка и расходы",
    ebitdaTrend: "EBITDA",
    netTrend: "Чистая прибыль",
    cashFlow: "Денежный поток",
    departments: "Прибыль по отделам",
    clients: "Топ клиентов по прибыльности",
    expenseCats: "Крупнейшие расходы",
    upcoming: "Предстоящие платежи",
    risks: "Финансовые риски",
    noRisks: "Рисков не обнаружено",
    budgetVsActual: "Бюджет и факт",
    owners: "Распределения собственникам",
    none: "Нет данных",
    budget: "План",
    actual: "Факт",
    allocated: "Распределено",
    paid: "Выплачено",
    open: "Открыть",
    payrollMonth: "Финлист этого месяца",
    rowsConfirmed: "строк подтверждено",
    noReports: "У вас нет доступа к финансовым отчётам. Откройте финлист.",
    riskText: {
      runway: "Запас хода меньше 3 месяцев: {v} мес.",
      reserve: "Остаток ниже резерва на {v}",
      forecast: "Базовый прогноз: отрицательный остаток в ближайшие 3 месяца",
      loss: "Убыток за период: {v}",
      overdueReceivables: "Просроченная дебиторка: {v}",
      overduePayables: "Просроченная кредиторка: {v}",
      opexOverBudget: "Операционные расходы выше бюджета на {v}",
      unbalanced: "Баланс не сходится на {v}",
    },
    payrollLabel: "Зарплата к выплате",
    distributionsLabel: "Распределения к выплате",
  },
  en: {
    netProfitPeriod: "Net profit",
    target: "Target",
    noTarget: "No target set — add one in Budgets",
    ofTarget: "of target",
    left: "to go",
    vsPrev: "vs previous period",
    turnover: "Client budgets / turnover",
    revenue: "Agency revenue",
    expenses: "Total expenses",
    grossProfit: "Gross profit",
    ebitda: "EBITDA",
    ebit: "EBIT",
    netProfit: "Net profit",
    netMargin: "Net profit margin",
    cash: "Cash balance",
    cashIn: "Cash received",
    cashInInfo: "Money actually received in the period (client payments, budgets, contributions, loans). Not the same as revenue.",
    cashOut: "Cash paid out",
    cashOutInfo: "Money actually paid in the period: salaries, expenses, owner and investor payouts.",
    cashEnd: "Cash at period end",
    payroll: "Payroll obligations",
    revenueVsExpenses: "Revenue and expenses",
    ebitdaTrend: "EBITDA",
    netTrend: "Net profit",
    cashFlow: "Cash flow",
    departments: "Profit by department",
    clients: "Top clients by profitability",
    expenseCats: "Biggest expenses",
    upcoming: "Upcoming payments",
    risks: "Financial risks",
    noRisks: "No risks detected",
    budgetVsActual: "Budget vs actual",
    owners: "Owner distributions",
    none: "No data",
    budget: "Budget",
    actual: "Actual",
    allocated: "Allocated",
    paid: "Paid",
    open: "Open",
    payrollMonth: "This month's sheet",
    rowsConfirmed: "rows confirmed",
    noReports: "You do not have access to financial reports. Open the sheet.",
    riskText: {
      runway: "Runway under 3 months: {v} mo.",
      reserve: "Cash below reserve by {v}",
      forecast: "Base forecast: negative cash within 3 months",
      loss: "Loss for the period: {v}",
      overdueReceivables: "Overdue receivables: {v}",
      overduePayables: "Overdue payables: {v}",
      opexOverBudget: "Operating expenses over budget by {v}",
      unbalanced: "Balance sheet off by {v}",
    },
    payrollLabel: "Salaries owed",
    distributionsLabel: "Distributions owed",
  },
}

export default function DashboardPage({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-muted/20" />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  )
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const user = await requireUser()
  const { locale } = await getDictionary()
  const t = T[locale]
  const rt = reportTexts[locale]
  const firstName = (user.displayName ?? user.email.split("@")[0]).split(/[\s.]+/)[0]
  const { range, period } = reportParams(await searchParams)
  const sheet = can(user, "payroll:read") && can(user, "salary:read") ? await getSheet(user, currentMonth()) : null

  if (!can(user, "reports:read")) {
    return (
      <div className="flex flex-col gap-8">
        <Greeting name={firstName} />
        <p className="text-sm text-muted-foreground">{t.noReports} <Link href="/payroll" className="text-primary hover:underline">→</Link></p>
      </div>
    )
  }

  const d = await executiveDashboard(user, range)
  const money = (v: string | null | undefined, decimals = 0) => (v === null || v === undefined ? "—" : formatAmount(v, user.baseCurrency, locale, { decimals }))
  const p = d.pnl
  const target = d.target
  const progress = target && new Decimal(target).gt(0) ? Math.max(0, Math.min(100, new Decimal(p.netProfit).div(target).mul(100).toNumber())) : 0
  const netGrowth = growth(p.netProfit, d.previous.netProfit)
  const labels = MONTHS[locale]
  const confirmed = sheet ? sheet.rows.filter((r) => r.confirmed && !r.stale).length : 0

  const kpis: { label: string; value: string; info?: string; href: string; tone?: "neg" }[] = [
    { label: t.turnover, value: money(d.managedBudget), info: rt.metrics.managedBudget[1], href: "/analytics" },
    { label: t.revenue, value: money(p.revenue), info: rt.metrics.revenue[1], href: `/pnl?p=${period}` },
    { label: t.expenses, value: money(p.totalExpenses), info: rt.metrics.totalExpenses[1], href: `/pnl?p=${period}` },
    { label: t.grossProfit, value: money(p.grossProfit), info: rt.metrics.grossProfit[1], href: `/pnl?p=${period}`, tone: Number(p.grossProfit) < 0 ? "neg" : undefined },
    { label: t.ebitda, value: money(p.ebitda), info: rt.metrics.ebitda[1], href: `/profitability?p=${period}`, tone: Number(p.ebitda) < 0 ? "neg" : undefined },
    { label: t.ebit, value: money(p.ebit), info: rt.metrics.ebit[1], href: `/profitability?p=${period}`, tone: Number(p.ebit) < 0 ? "neg" : undefined },
    { label: t.netProfit, value: money(p.netProfit), info: rt.metrics.netProfit[1], href: `/pnl?p=${period}`, tone: Number(p.netProfit) < 0 ? "neg" : undefined },
    { label: t.netMargin, value: p.margins.net === null ? "—" : `${p.margins.net}%`, info: rt.metrics.netMargin[1], href: `/profitability?p=${period}` },
    { label: t.cashIn, value: money(d.cash.inflow), info: t.cashInInfo, href: `/cash-flow?p=${period}` },
    { label: t.cashOut, value: money(d.cash.outflow), info: t.cashOutInfo, href: `/cash-flow?p=${period}` },
    { label: t.cashEnd, value: money(d.cash.closing), info: rt.metrics.cashBalance[1], href: `/cash-flow?p=${period}` },
    { label: t.payroll, value: money(d.indicators.payrollPayable), info: rt.metrics.payrollObligations[1], href: "/payroll" },
  ]

  const budgetRows = [
    { label: t.revenue, budget: d.budget.revenue, actual: p.revenue, cost: false },
    { label: rt.pnl.costOfServices, budget: d.budget.directCosts, actual: p.costOfServices, cost: true },
    { label: rt.pnl.operatingExpenses, budget: d.budget.opex, actual: p.operatingExpenses, cost: true },
    { label: t.ebitda, budget: d.budget.ebitda, actual: p.ebitda, cost: false },
    { label: t.netProfit, budget: d.budget.netProfit, actual: p.netProfit, cost: false },
  ]

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <Greeting name={firstName} />
        <PeriodPicker value={period} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        {/* Hero: net profit for the period vs target */}
        <Link href={`/pnl?p=${period}`} className="relative flex flex-col justify-between gap-10 overflow-hidden rounded-3xl border border-primary/40 bg-[radial-gradient(ellipse_at_top_left,rgba(190,24,93,0.38),rgba(20,14,20,0.92)_60%)] p-8 transition-colors hover:border-primary/70">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:28px_28px]" />
          <div className="relative">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-foreground/70">{t.netProfitPeriod} · {rangeLabel(range, locale)}</p>
            <p className={cn("mt-4 font-display text-5xl font-black tracking-tight italic sm:text-7xl", Number(p.netProfit) < 0 && "text-red-300")}>{money(p.netProfit)}</p>
            {netGrowth !== null && (
              <span className={cn("mt-4 inline-flex rounded-full border px-2.5 py-0.5 text-xs", Number(netGrowth) >= 0 ? "border-emerald-400/40 text-emerald-300" : "border-red-400/40 text-red-300")}>
                {Number(netGrowth) >= 0 ? "+" : ""}{netGrowth}% <span className="ml-1 text-foreground/60">{t.vsPrev}</span>
              </span>
            )}
          </div>
          <div className="relative">
            {target ? (
              <>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-white" style={{ width: `${progress}%` }} /></div>
                <div className="mt-3 flex justify-between text-sm text-foreground/80">
                  <span>{Math.round(progress)}% {t.ofTarget} {money(target)}</span>
                  <span>{t.left} {money(Decimal.max(0, new Decimal(target).sub(p.netProfit)).toString())}</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t.noTarget}</p>
            )}
          </div>
        </Link>

        {/* Risks */}
        <section className="rounded-3xl border border-border bg-card/60 p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t.risks}</p>
          <div className="mt-5 flex flex-col gap-2.5">
            {d.risks.length === 0 ? (
              <span className="flex items-center gap-2 text-sm text-foreground/80"><CircleCheck className="size-4 text-primary" /> {t.noRisks}</span>
            ) : (
              d.risks.map((r) => (
                <Link key={r.key} href={r.href} className={cn("flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm hover:border-primary/50", r.level === "high" ? "border-red-500/40 bg-red-500/5" : "border-border")}>
                  <TriangleAlert className={cn("mt-0.5 size-4 shrink-0", r.level === "high" ? "text-red-300" : "text-amber-300")} />
                  {t.riskText[r.key as keyof typeof t.riskText].replace("{v}", r.key === "runway" ? (r.value ?? "") : money(r.value))}
                </Link>
              ))
            )}
            {sheet && sheet.rows.length > 0 && (
              <Link href="/payroll" className="mt-2 flex items-center justify-between rounded-2xl border border-border px-4 py-3 text-sm hover:border-primary/50">
                <span>{t.payrollMonth}: {confirmed}/{sheet.rows.length} {t.rowsConfirmed}</span>
                <ArrowRight className="size-4 text-muted-foreground" />
              </Link>
            )}
          </div>
        </section>
      </div>

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="relative flex flex-col gap-2 rounded-2xl border border-border bg-card/60 p-5 transition-colors hover:border-primary/50">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{k.label} {k.info && <span className="relative z-10"><InfoTip text={k.info} /></span>}</span>
            {/* The link covers the card; the info icon sits above it. */}
            <Link href={k.href} className={cn("font-display text-xl font-black after:absolute after:inset-0 after:rounded-2xl", k.tone === "neg" && "text-red-300")}>{k.value}</Link>
          </div>
        ))}
      </div>

      {/* Trends */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Widget title={`${t.revenueVsExpenses} · ${range.year}`} href="/analytics">
          <div className="relative">
            <BarChart data={d.series.map((s, i) => ({ label: labels[i], value: Number(s.revenue) }))} />
            <div className="absolute inset-0"><LineChart data={d.series.map((s, i) => ({ label: labels[i], value: Number(s.expenses) }))} className="h-40" /></div>
          </div>
          <ChartLabels labels={labels} />
        </Widget>
        <Widget title={`${t.ebitdaTrend} · ${range.year}`} href="/profitability">
          <BarChart data={d.series.map((s, i) => ({ label: labels[i], value: Number(s.ebitda) }))} />
          <ChartLabels labels={labels} />
        </Widget>
        <Widget title={`${t.netTrend} · ${range.year}`} href="/profitability">
          <BarChart data={d.series.map((s, i) => ({ label: labels[i], value: Number(s.netProfit) }))} />
          <ChartLabels labels={labels} />
        </Widget>
        <Widget title={`${t.cashFlow} · ${range.year}`} href="/cash-flow">
          <BarChart data={d.series.map((s, i) => ({ label: labels[i], value: Number(s.netCash) }))} />
          <ChartLabels labels={labels} />
        </Widget>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Widget title={t.departments} href={`/profitability?p=${period}`}>
          {d.departments.length ? <ShareBars data={d.departments.map((x) => ({ label: x.name, value: Number(x.netProfit) }))} format={(v) => money(String(v))} /> : <Empty text={t.none} />}
        </Widget>
        <Widget title={t.clients} href={`/pnl?p=${period}`}>
          {d.clients.length ? (
            <div className="flex flex-col gap-2.5">
              {d.clients.map((c) => (
                <Link key={c.id} href={`/pnl?p=${period}&client=${c.id}`} className="flex items-center justify-between gap-3 text-sm hover:text-primary">
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 font-mono">{money(c.profit)} <span className="text-xs text-muted-foreground">/ {money(c.revenue)}</span></span>
                </Link>
              ))}
            </div>
          ) : <Empty text={t.none} />}
        </Widget>
        <Widget title={t.expenseCats} href={`/pnl?p=${period}`}>
          {d.expenses.length ? <ShareBars data={d.expenses.map((e) => ({ label: e.name, value: Number(e.amount) }))} format={(v) => money(String(v))} /> : <Empty text={t.none} />}
        </Widget>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Widget title={t.upcoming} href="/cash-flow">
          {d.upcoming.length ? (
            <div className="flex flex-col gap-2.5">
              {d.upcoming.map((u) => (
                <Link key={u.key} href={u.href} className="flex items-center justify-between gap-3 text-sm hover:text-primary">
                  <span className="truncate">{u.label === "payroll" ? t.payrollLabel : u.label === "distributions" ? t.distributionsLabel : u.label}{u.due && <span className="ml-1.5 text-xs text-muted-foreground">{formatDate(u.due, locale)}</span>}</span>
                  <span className="shrink-0 font-mono">{money(u.amount)}</span>
                </Link>
              ))}
            </div>
          ) : <Empty text={t.none} />}
        </Widget>
        <Widget title={t.budgetVsActual} href="/budgets">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground"><tr><th className="pb-2 text-left font-medium" /><th className="pb-2 text-right font-medium">{t.budget}</th><th className="pb-2 text-right font-medium">{t.actual}</th><th className="pb-2 text-right font-medium">%</th></tr></thead>
            <tbody>
              {budgetRows.map((b) => {
                const pctOf = b.budget ? percent(b.actual, b.budget) : null
                const good = b.budget ? (b.cost ? new Decimal(b.actual).lte(b.budget) : new Decimal(b.actual).gte(b.budget)) : null
                return (
                  <tr key={b.label} className="border-t border-border/40">
                    <td className="py-1.5">{b.label}</td>
                    <td className="py-1.5 text-right font-mono text-muted-foreground">{money(b.budget)}</td>
                    <td className="py-1.5 text-right font-mono">{money(b.actual)}</td>
                    <td className={cn("py-1.5 text-right font-mono text-xs", good === null ? "text-muted-foreground" : good ? "text-emerald-300/90" : "text-red-300/90")}>{pctOf === null ? "—" : `${pctOf}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Widget>
        <Widget title={`${t.owners} · ${range.year}`} href="/owners">
          {d.owners.length ? (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground"><tr><th className="pb-2 text-left font-medium" /><th className="pb-2 text-right font-medium">{t.allocated}</th><th className="pb-2 text-right font-medium">{t.paid}</th></tr></thead>
              <tbody>
                {d.owners.map((o) => (
                  <tr key={o.name} className="border-t border-border/40"><td className="py-1.5">{o.name}</td><td className="py-1.5 text-right font-mono">{money(o.allocated)}</td><td className="py-1.5 text-right font-mono">{money(o.paid)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty text={t.none} />}
        </Widget>
      </div>
    </div>
  )
}

function Widget({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col rounded-3xl border border-border bg-card/60 p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
        <Link href={href} className="text-xs text-muted-foreground hover:text-primary" aria-label={title}>→</Link>
      </div>
      {children}
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>
}
