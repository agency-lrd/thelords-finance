import { ArrowLeft, ShieldAlert } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { cn } from "cn"

import { AiCommentary, PdfButton } from "@/components/ai-cfo/report-actions"
import { PeriodPicker } from "@/components/reports/period-picker"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { aiConfigured } from "@/lib/ai/config"
import type { Completeness, SourceRef } from "@/lib/ai/envelope"
import { monthlyReport } from "@/lib/ai/report"
import { requirePageAccess } from "@/lib/auth/session"
import { aiTexts } from "@/lib/i18n/ai-cfo"
import { formatAmount, type Locale } from "@/lib/i18n/format"
import { getDictionary } from "@/lib/i18n/server"
import { currentRange, parseRange, previous, rangeLabel } from "@/lib/reports/periods"

export const metadata: Metadata = { title: "CFO report" }

export default function CfoReportPage({ searchParams }: PageProps<"/ai-cfo/report">) {
  return (
    <Suspense fallback={<PageSkeleton title="CFO report" />}>
      <CfoReport searchParams={searchParams} />
    </Suspense>
  )
}

type Cell = string | null | undefined
type Row = { label: string; cells: Cell[]; strong?: boolean; negative?: boolean }

function Table({ head, rows, numericFrom = 1 }: { head: string[]; rows: Row[]; numericFrom?: number }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full text-sm">
        <thead className="bg-muted/30">
          <tr>{head.map((h, i) => <th key={h + i} className={cn("whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground", i >= numericFrom ? "text-right" : "text-left")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.label + i} className={cn("border-t border-border/40", r.strong && "font-semibold")}>
              <td className="px-3 py-1.5">{r.label}</td>
              {r.cells.map((c, j) => <td key={j} className={cn("whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums", r.negative && j === 0 && "text-red-400")}>{c ?? "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SectionBox({ n, title, sources, completeness, children, locale }: { n: number; title: string; sources?: SourceRef[]; completeness?: Completeness; children: React.ReactNode; locale: Locale }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card/40 p-5 print:break-inside-avoid">
      <h2 className="font-display text-xl font-black uppercase italic">
        <span className="mr-2 text-primary">{String(n).padStart(2, "0")}</span>
        {title}
      </h2>
      {children}
      {(sources?.length || completeness?.notes.length) && (
        <div className="flex flex-col gap-1 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
          {completeness && completeness.notes.length > 0 && <p className="text-amber-300 print:text-amber-700">{completeness.notes.join(" ")}</p>}
          {sources && sources.length > 0 && (
            <p>
              {locale === "ru" ? "Источники: " : "Sources: "}
              {sources.slice(0, 6).map((s, i) => (
                <span key={s.href + s.label}>
                  {i > 0 && " · "}
                  <Link href={s.href} className="underline-offset-4 hover:text-primary hover:underline">{s.label}</Link>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

async function CfoReport({ searchParams }: { searchParams: PageProps<"/ai-cfo/report">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = aiTexts[locale]
  const R = t.reportPage
  const params = await searchParams
  // Monthly report: default to the last complete month.
  const r = parseRange(typeof params.p === "string" && /^\d{4}-\d{2}$/.test(params.p) ? params.p : null, previous(currentRange("month")))
  const data = await monthlyReport(user, r)
  const money = (v: Cell) => formatAmount(v ?? null, user.baseCurrency, locale, { decimals: 0 })
  const pct = (v: Cell) => (v === null || v === undefined ? "—" : `${v}%`)
  const na = (p: string) => <p className="text-sm text-muted-foreground">{R.notAvailable.replace("{p}", p)}</p>
  const s = data.summary

  const pnlRow = (k: keyof typeof R.rows & string, strong = false): Row | null => {
    if (!s.available) return null
    const cur = (s.values.current as unknown as Record<string, string>)[k]
    const prev = s.values.vsPreviousPeriod[k] as { previous: string; changePct: string | null } | undefined
    const ago = s.values.vsYearAgo[k] as { previous: string; changePct: string | null } | undefined
    return { label: R.rows[k], cells: [money(cur), money(prev?.previous), pct(prev?.changePct), money(ago?.previous)], strong, negative: Number(cur) < 0 }
  }
  const alerts = data.alerts.available ? data.alerts.values.alerts : []
  const actions = [...new Set(alerts.map((a) => a.code))]

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Link href="/ai-cfo" data-print-hide className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"><ArrowLeft className="size-3.5" /> {R.back}</Link>
          <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{R.title}</h1>
          <p className="text-lg font-semibold">{user.organizationName} · {rangeLabel(r, locale)}</p>
          <p className="max-w-3xl text-sm text-muted-foreground" data-print-hide>{R.description}</p>
          <p className="hidden text-xs text-muted-foreground print:block">{R.period}: {data.from} — {data.to} · {user.baseCurrency}</p>
        </div>
        <PdfButton fileName={`CFO-report-${r.key}`} />
      </div>
      <div data-print-hide>
        <PeriodPicker value={r.key} kinds={["month"]} />
      </div>

      {/* 1. Executive summary */}
      <SectionBox n={1} title={R.sections[0]} sources={s.available ? s.sources : undefined} completeness={s.available ? s.completeness : undefined} locale={locale}>
        {!s.available ? na(s.permission) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(["revenue", "ebitda", "netProfit"] as const).map((k) => (
                <div key={k} className="rounded-xl border border-border/60 p-3">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{R.rows[k]}</p>
                  <p className={cn("font-display text-xl font-black", Number(s.values.current[k]) < 0 && "text-red-400")}>{money(s.values.current[k])}</p>
                  <p className="text-xs text-muted-foreground">{pct((s.values.vsPreviousPeriod[k] as { changePct: string | null }).changePct)} {locale === "ru" ? "к пред. месяцу" : "vs prev. month"}</p>
                </div>
              ))}
              <div className="rounded-xl border border-border/60 p-3">
                <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{R.rows.closingCash}</p>
                <p className={cn("font-display text-xl font-black", Number(s.values.cash.closingCash) < 0 && "text-red-400")}>{money(s.values.cash.closingCash)}</p>
                <p className="text-xs text-muted-foreground">{s.values.liquidity.runwayMonths ? `${R.rows.runway}: ${s.values.liquidity.runwayMonths}` : `${R.rows.netChange}: ${money(s.values.cash.netCashFlow)}`}</p>
              </div>
            </div>
            {alerts.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {alerts.filter((a) => a.severity === "high").concat(alerts.filter((a) => a.severity !== "high")).slice(0, 4).map((a, i) => (
                  <li key={a.code + i} className="flex gap-2"><ShieldAlert className={cn("mt-0.5 size-4 shrink-0", a.severity === "high" ? "text-red-400" : "text-amber-400")} />{t.alert[a.code]}{a.subject ? ` · ${a.subject.name}` : ""}: <span className="text-muted-foreground">{a.rule}</span></li>
                ))}
              </ul>
            )}
          </>
        )}
      </SectionBox>

      {/* 2. Revenue */}
      <SectionBox n={2} title={R.sections[1]} sources={data.clients.available ? data.clients.sources : undefined} locale={locale}>
        {s.available && <Table head={[R.metric, R.actual, R.previous, R.change, R.yearAgo]} rows={[pnlRow("revenue", true)!]} />}
        {!data.clients.available ? na(data.clients.permission) : data.clients.values.clients.length === 0 ? <p className="text-sm text-muted-foreground">{R.noClients}</p> : (
          <>
            <Table head={[R.client, R.amount, R.share, R.change]} rows={data.clients.values.clients.map((c) => ({ label: c.client, cells: [money(c.revenue), pct(c.shareOfRevenuePct), pct(c.revenueChangePct)] }))} />
            <p className="text-sm text-muted-foreground">{R.concentration.replace("{a}", data.clients.values.concentration.largestClientSharePct ?? "—").replace("{b}", data.clients.values.concentration.top3SharePct ?? "—")}</p>
            {data.clients.values.lostClients.length > 0 && <p className="text-sm text-muted-foreground">{R.lostClients}: {data.clients.values.lostClients.map((c) => `${c.client} (${money(c.previousRevenue)})`).join(", ")}</p>}
          </>
        )}
      </SectionBox>

      {/* 3. Cost structure */}
      <SectionBox n={3} title={R.sections[2]} sources={data.expenses.available ? data.expenses.sources.slice(0, 1) : undefined} locale={locale}>
        {!data.expenses.available ? na(data.expenses.permission) : (
          <Table
            head={[R.account, R.amount, R.share, R.previous, R.change]}
            rows={[
              ...data.expenses.values.lines.slice(0, 12).map((l) => ({ label: l.account, cells: [money(l.amount), pct(l.shareOfExpensesPct), money(l.previous), pct(l.changePct)] })),
              { label: locale === "ru" ? "Итого расходы" : "Total expenses", cells: [money(data.expenses.values.totalExpenses), "100%", money(data.expenses.values.previousTotalExpenses), pct(data.expenses.values.totalChangePct)], strong: true },
            ]}
          />
        )}
      </SectionBox>

      {/* 4. Departments */}
      <SectionBox n={4} title={R.sections[3]} sources={data.departments.available ? data.departments.sources.slice(0, 1) : undefined} locale={locale}>
        {!data.departments.available ? na(data.departments.permission) : data.departments.values.departments.length === 0 ? <p className="text-sm text-muted-foreground">{R.noDepartments}</p> : (
          <Table
            head={[R.department, R.rows.revenue, "EBITDA", R.rows.netProfit, R.margin, R.change]}
            rows={[
              ...data.departments.values.departments.map((d) => ({ label: d.department, cells: [money(d.revenue), money(d.ebitda), money(d.netProfit), pct(d.marginsPct.net), pct(d.netProfitChangePct)], negative: false })),
              { label: R.unattributed, cells: [money(data.departments.values.notAttributedToDepartments.revenue), "—", money(data.departments.values.notAttributedToDepartments.netProfit), "—", "—"] },
            ]}
          />
        )}
      </SectionBox>

      {/* 5. EBITDA and EBIT */}
      <SectionBox n={5} title={R.sections[4]} sources={data.ebitda.available ? data.ebitda.sources.slice(0, 1) : undefined} locale={locale}>
        {!data.ebitda.available || !data.ebit.available ? na("reports:read") : (
          <>
            <Table head={[R.metric, R.actual, R.previous, R.change, R.yearAgo]} rows={[pnlRow("revenue"), pnlRow("costOfServices"), pnlRow("operatingExpenses"), pnlRow("ebitda", true), pnlRow("depreciationAndAmortization"), pnlRow("ebit", true)].filter((x): x is Row => !!x)} />
            <p className="text-sm text-muted-foreground">EBITDA {pct(data.ebitda.values.marginPct)} · EBIT {pct(data.ebit.values.marginPct)} {R.margin.toLowerCase()}</p>
            {data.ebitda.values.drivers.length > 0 && (
              <>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{R.drivers}</p>
                <Table head={[R.account, R.actual, R.previous, R.profitEffect]} rows={data.ebitda.values.drivers.slice(0, 8).map((d) => ({ label: d.account, cells: [money(d.current), money(d.previous), money(d.profitEffect)] }))} />
              </>
            )}
          </>
        )}
      </SectionBox>

      {/* 6. Net profit */}
      <SectionBox n={6} title={R.sections[5]} locale={locale}>
        {!s.available ? na(s.permission) : (
          <Table head={[R.metric, R.actual, R.previous, R.change, R.yearAgo]} rows={[pnlRow("ebit"), pnlRow("otherIncomeAndExpense"), pnlRow("profitBeforeTax"), pnlRow("incomeTax"), pnlRow("netProfit", true)].filter((x): x is Row => !!x)} />
        )}
      </SectionBox>

      {/* 7. Cash flow */}
      <SectionBox n={7} title={R.sections[6]} sources={data.cash.available ? data.cash.sources : undefined} completeness={data.cash.available && !data.cash.values.reconciledWithAccounts ? data.cash.completeness : undefined} locale={locale}>
        {!data.cash.available ? na(data.cash.permission) : (
          <>
            <Table
              head={[R.metric, R.amount]}
              rows={(["openingCash", "operating", "investing", "financing", "netChange", "closingCash"] as const).map((k) => ({ label: R.rows[k], cells: [money(data.cash.available ? data.cash.values[k] : null)], strong: k === "closingCash" || k === "netChange" }))
                .concat([
                  { label: R.rows.burn, cells: [money(data.cash.values.indicators.burn)], strong: false },
                  { label: R.rows.runway, cells: [data.cash.values.indicators.runwayMonths ?? "—"], strong: false },
                  { label: R.rows.receivables, cells: [money(data.cash.values.indicators.receivables)], strong: false },
                  { label: R.rows.overdueReceivables, cells: [money(data.cash.values.indicators.overdueReceivables)], strong: false },
                  { label: R.rows.payables, cells: [money(data.cash.values.indicators.payables)], strong: false },
                ])}
            />
            <p className={cn("text-xs", data.cash.values.reconciledWithAccounts ? "text-muted-foreground" : "text-red-400")}>{data.cash.values.reconciledWithAccounts ? R.reconciled : R.notReconciled}</p>
            {data.forecast.available && data.forecast.values.status === "ok" && (
              <>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{R.forecastNote}</p>
                <Table head={["", ...data.forecast.values.scenarios.BASE.months.map((m) => m.month)]} rows={[{ label: R.rows.netChange, cells: data.forecast.values.scenarios.BASE.months.map((m) => money(m.cashFlow)) }, { label: R.rows.closingCash, cells: data.forecast.values.scenarios.BASE.months.map((m) => money(m.closingCash)), strong: true }]} />
              </>
            )}
          </>
        )}
      </SectionBox>

      {/* 8. Risks */}
      <SectionBox n={8} title={R.sections[7]} sources={data.alerts.available ? data.alerts.sources : undefined} locale={locale}>
        {!data.alerts.available ? na(data.alerts.permission) : alerts.length === 0 ? <p className="text-sm text-muted-foreground">{t.insights.noAlerts}</p> : (
          <ul className="flex flex-col gap-2">
            {alerts.map((a, i) => (
              <li key={a.code + i} className="flex gap-3 text-sm">
                <ShieldAlert className={cn("mt-0.5 size-4 shrink-0", a.severity === "high" ? "text-red-400" : a.severity === "medium" ? "text-amber-400" : "text-muted-foreground")} />
                <div>
                  <p className="font-medium">{t.alert[a.code]}{a.subject ? ` · ${a.subject.name}` : ""} <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t.severity[a.severity]}</span></p>
                  <p className="text-xs text-muted-foreground">{a.rule}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionBox>

      {/* 9. Budget variance */}
      <SectionBox n={9} title={R.sections[8]} sources={data.budget.available ? data.budget.sources : undefined} locale={locale}>
        {!data.budget.available ? na(data.budget.permission) : !data.budget.values.budgetSet ? <p className="text-sm text-muted-foreground">{R.noBudget}</p> : (
          <Table
            head={[R.metric, R.actual, R.budget, R.variance, "%"]}
            rows={data.budget.values.metrics.filter((m) => m.budget !== null).map((m) => ({ label: (R.rows as Record<string, string>)[m.metric] ?? m.metric, cells: [money(m.actual), money(m.budget), `${m.favourable === false ? "▼ " : m.favourable ? "▲ " : ""}${money(m.variance)}`, pct(m.variancePct)] }))}
          />
        )}
      </SectionBox>

      {/* 10. Recommended actions */}
      <SectionBox n={10} title={R.sections[9]} locale={locale}>
        {actions.length === 0 ? <p className="text-sm text-muted-foreground">{R.noActions}</p> : (
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
            {actions.map((code) => <li key={code}><span className="font-medium">{t.alert[code]}:</span> {R.action[code]}</li>)}
          </ol>
        )}
      </SectionBox>

      <AiCommentary period={r.key} configured={aiConfigured()} />
    </div>
  )
}
