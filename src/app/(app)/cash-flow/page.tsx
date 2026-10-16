import { CircleCheck, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"
import { Suspense } from "react"
import { cn } from "cn"

import { InfoTip } from "@/components/reports/info"
import { ReportHeader } from "@/components/reports/report-header"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { requirePageAccess } from "@/lib/auth/session"
import { budgetForRange } from "@/lib/data/budgets"
import { formatAmount } from "@/lib/i18n/format"
import { fill } from "@/lib/i18n/dictionaries"
import { reportTexts } from "@/lib/i18n/reports"
import { getDictionary } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { cashForecast, cashIndicators } from "@/lib/reports/cash"
import { cashFlowReport } from "@/lib/reports/ledger"
import { reportParams } from "@/lib/reports/params"
import { CASH_ACTIVITY, type CashLineKey } from "@/lib/reports/statements"

export const metadata: Metadata = { title: "Cash Flow" }

export default function CashFlowPage({ searchParams }: PageProps<"/cash-flow">) {
  return (
    <Suspense fallback={<PageSkeleton title="Cash Flow" />}>
      <CashFlow searchParams={searchParams} />
    </Suspense>
  )
}

async function CashFlow({ searchParams }: { searchParams: PageProps<"/cash-flow">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = reportTexts[locale]
  const { range, period } = reportParams(await searchParams)
  const today = new Date(new Date().toISOString().slice(0, 10))
  const asOf = range.to < today ? range.to : today
  const [{ flow, actualClosing, reconciled }, indicators, forecast, budget] = await Promise.all([
    cashFlowReport(user, range),
    cashIndicators(user, asOf),
    cashForecast(user, today, 3),
    budgetForRange(user, range),
  ])
  const money = (v: string | null) => (v === null ? "—" : formatAmount(v, user.baseCurrency, locale))
  const minimum = budget.metric("CASH_RESERVE")
  const surplus = minimum ? new Decimal(flow.closingCash).sub(minimum).toString() : null

  const group = ({ activity, title }: { activity: "operating" | "investing" | "financing"; title: string }) => (
    <>
      <tr className="border-t border-border/60">
        <td className="px-4 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary" colSpan={2}>{title}</td>
      </tr>
      {(Object.keys(CASH_ACTIVITY) as CashLineKey[]).filter((k) => CASH_ACTIVITY[k] === activity).map((k) => (
        <tr key={k}>
          <td className="py-1.5 pr-4 pl-8 text-foreground/85">{t.cf[k]}</td>
          <td className={cn("px-4 py-1.5 text-right font-mono", flow.lines[k] === "0" && "text-muted-foreground/60")}>{money(flow.lines[k])}</td>
        </tr>
      ))}
      <tr className="border-t border-border/40 bg-white/[0.02]">
        <td className="px-4 py-2 font-medium">{title}</td>
        <td className="px-4 py-2 text-right font-mono font-semibold">{money(flow[activity])}</td>
      </tr>
    </>
  )

  const stat = ({ label, value, info, tone }: { label: string; value: string; info?: string; tone?: "warn" }) => (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card/60 p-5">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label} {info && <InfoTip text={info} />}</p>
      <p className={cn("font-display text-xl font-black", tone === "warn" && "text-amber-300")}>{value}</p>
    </div>
  )

  return (
    <div className="flex flex-col gap-8">
      <ReportHeader title={t.cf.title} description={t.cf.description} period={period} />
      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <div className="overflow-hidden rounded-2xl bg-card/50 ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <tbody>
              <tr className="bg-white/[0.03]">
                <td className="px-4 py-3 font-display font-black uppercase italic">{t.cf.opening}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold">{money(flow.openingCash)}</td>
              </tr>
              {group({ activity: "operating", title: t.cf.operating })}
              {group({ activity: "investing", title: t.cf.investing })}
              {group({ activity: "financing", title: t.cf.financing })}
              <tr className="border-t border-border">
                <td className="px-4 py-2.5 font-medium">{t.cf.netChange}</td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold">{money(flow.netChange)}</td>
              </tr>
              <tr className="border-t border-primary/50 bg-[#3a0d29] text-white">
                <td className="px-4 py-3 font-display font-black uppercase italic">{t.cf.closing}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold">{money(flow.closingCash)}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-muted-foreground">{t.cf.minimum}</td>
                <td className="px-4 py-2 text-right font-mono text-muted-foreground">{money(minimum)}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">{t.cf.surplus}</td>
                <td className={cn("px-4 py-2 text-right font-mono font-semibold", surplus && new Decimal(surplus).isNegative() && "text-red-300")}>{money(surplus)}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-xs text-muted-foreground">{t.cf.transfers}</td>
                <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">{money(flow.internalTransfers)}</td>
              </tr>
            </tbody>
          </table>
          <p className={cn("flex items-center gap-2 border-t border-border px-4 py-3 text-xs", reconciled ? "text-emerald-300/90" : "text-red-300")}>
            {reconciled ? <CircleCheck className="size-4" /> : <TriangleAlert className="size-4" />}
            {reconciled ? t.cf.reconciled : `${t.cf.notReconciled} (${money(actualClosing)})`}
          </p>
        </div>

        <div className="flex flex-col gap-6">
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.cf.indicators}</p>
            <div className="grid grid-cols-2 gap-3">
              {stat({ label: t.cf.burn, value: indicators.burn === "0" ? t.cf.noBurn : money(indicators.burn) })}
              {stat({ label: t.cf.runway, value: indicators.runwayMonths ? `${indicators.runwayMonths} ${t.cf.months}` : "—", tone: indicators.runwayMonths && Number(indicators.runwayMonths) < 3 ? "warn" : undefined })}
              {stat({ label: t.cf.upcomingPayroll, value: money(indicators.payrollPayable), info: t.metrics.payrollObligations[1] })}
              {stat({ label: t.cf.upcomingExpenses, value: money(indicators.payables), info: t.metrics.payables[1] })}
              {stat({ label: t.cf.expectedReceipts, value: money(indicators.receivables), info: t.metrics.receivables[1] })}
              {stat({ label: t.cf.overdueReceivables, value: money(indicators.overdueReceivables), tone: indicators.overdueReceivables !== "0" ? "warn" : undefined })}
              {stat({ label: t.cf.overduePayables, value: money(indicators.overduePayables), tone: indicators.overduePayables !== "0" ? "warn" : undefined })}
            </div>
          </div>
          <div className="rounded-2xl border border-dashed border-primary/40 p-5">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.cf.forecast}</p>
            <p className="mb-4 text-xs text-muted-foreground">{t.cf.forecastNote}</p>
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                <tr>
                  <th className="py-1.5 text-left font-medium" />
                  {forecast.scenarios.BASE.map((m) => <th key={m.month} className="py-1.5 text-right font-medium">{m.month}</th>)}
                </tr>
              </thead>
              <tbody>
                {(["CONSERVATIVE", "BASE", "AGGRESSIVE"] as const).map((s) => (
                  <tr key={s} className="border-t border-border/50">
                    <td className="py-1.5 text-muted-foreground">{s === "BASE" ? (locale === "ru" ? "Базовый" : "Base") : s === "CONSERVATIVE" ? (locale === "ru" ? "Консервативный" : "Conservative") : (locale === "ru" ? "Агрессивный" : "Aggressive")}</td>
                    {forecast.scenarios[s].map((m) => (
                      <td key={m.month} className={cn("py-1.5 text-right font-mono", new Decimal(m.closing).isNegative() && "text-red-300")} title={`${m.source}: ${m.net}`}>{money(m.closing)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {minimum && <p className="mt-3 text-xs text-muted-foreground">{fill(locale === "ru" ? "Резерв: {v}" : "Reserve: {v}", { v: money(minimum) })}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
