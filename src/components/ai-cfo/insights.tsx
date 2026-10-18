import { Lightbulb, ShieldAlert, TrendingUp } from "lucide-react"
import Link from "next/link"
import { cn } from "cn"

import type { SessionUser } from "@/lib/auth/session"
import type { Alert, Opportunity, Recommendation } from "@/lib/ai/diagnostics"
import type { Completeness } from "@/lib/ai/envelope"
import type { ForecastResult } from "@/lib/ai/forecast"
import { runTool } from "@/lib/ai/tools"
import { aiTexts, type AiTexts } from "@/lib/i18n/ai-cfo"
import { formatAmount, type Locale } from "@/lib/i18n/format"

import { AskAiButton } from "./insight-actions"

type Change = { previous: string; changePct: string | null; difference: string }
type Summary = {
  current: { revenue: string; ebitda: string; ebit: string; netProfit: string; marginsPct: { ebitda: string | null; net: string | null } }
  vsPreviousPeriod: Record<string, Change | string>
  cash: { closingCash: string; netCashFlow: string }
  liquidity: { runwayMonths: string | null }
}

/** Deterministic insights for a period: the same tools the AI uses, shown without AI. */
export async function Insights({ user, period, locale, configured }: { user: SessionUser; period: string; locale: Locale; configured: boolean }) {
  const t = aiTexts[locale]
  const money = (v: string | null | undefined) => formatAmount(v ?? null, user.baseCurrency, locale, { decimals: 0 })
  const summary = await runTool(user, "getFinancialSummary", { period })
  const alerts = await runTool(user, "getFinancialAlerts", { period })
  const forecast = await runTool(user, "getFinancialForecast", { months: 12 })
  const s = summary.values as Summary
  const findings = alerts.values as { alerts: Alert[]; opportunities: Opportunity[]; recommendations: Recommendation[]; dataSufficiency: { currentPeriodHasData: boolean } }
  const a = findings.alerts
  const explainPrompt =
    locale === "ru"
      ? `Объясни выявленные риски и возможности за ${period}: что из этого важнее всего, почему это произошло (с цифрами и источниками) и что делать в первую очередь.`
      : `Explain the risks and opportunities found for ${period}: what matters most, why it happened (with figures and sources), and what to do first.`
  const f = forecast.values as ForecastResult
  const prev = (k: string) => (s.vsPreviousPeriod[k] as Change | undefined)?.changePct ?? null
  const badge = (c: Completeness) => (c.status === "complete" ? null : <span className={cn("rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider", c.status === "no_data" ? "bg-red-500/15 text-red-300" : "bg-amber-500/15 text-amber-300")} title={c.notes.join(" ")}>{c.status === "no_data" ? t.insights.noData : t.insights.partial}</span>)

  const cards: { label: string; value: string; sub: string | null; negative: boolean }[] = [
    { label: "Revenue", value: s.current.revenue, sub: prev("revenue") ? `${prev("revenue")}% ${t.insights.vsPrev}` : null, negative: false },
    { label: "EBITDA", value: s.current.ebitda, sub: s.current.marginsPct.ebitda ? `${s.current.marginsPct.ebitda}%${prev("ebitda") ? ` · ${prev("ebitda")}% ${t.insights.vsPrev}` : ""}` : null, negative: Number(s.current.ebitda) < 0 },
    { label: "EBIT", value: s.current.ebit, sub: prev("ebit") ? `${prev("ebit")}% ${t.insights.vsPrev}` : null, negative: Number(s.current.ebit) < 0 },
    { label: locale === "ru" ? "Чистая прибыль" : "Net profit", value: s.current.netProfit, sub: s.current.marginsPct.net ? `${s.current.marginsPct.net}%` : null, negative: Number(s.current.netProfit) < 0 },
    { label: t.insights.closingCash, value: s.cash.closingCash, sub: s.liquidity.runwayMonths ? `${t.insights.runway}: ${s.liquidity.runwayMonths} ${t.insights.runwayMonths}` : null, negative: Number(s.cash.closingCash) < 0 },
    { label: "Cash Flow", value: s.cash.netCashFlow, sub: null, negative: Number(s.cash.netCashFlow) < 0 },
  ]
  if (locale === "ru") cards[0].label = "Выручка"

  return (
    <div className="flex flex-col gap-4">
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl font-black uppercase italic">{t.insights.title}</h2>
          {badge(summary.completeness)}
          <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{t.insights.calculated}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {cards.map((c) => (
            <div key={c.label} className="rounded-2xl border border-border bg-card/60 p-4">
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{c.label}</p>
              <p className={cn("mt-1 font-display text-xl font-black sm:text-2xl", c.negative && "text-red-300")}>{money(c.value)}</p>
              {c.sub && <p className="mt-1 text-xs text-muted-foreground">{c.sub}</p>}
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-border bg-card/60 p-4">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"><TrendingUp className="size-4 text-primary" /> {t.insights.forecast}</p>
          {f.status !== "ok" ? (
            <p className="text-sm text-muted-foreground">{t.insights.forecastNeedsHistory}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="py-1 text-left font-semibold">{t.insights.closingCash}</th>
                    {f.scenarios.BASE.horizons.map((h) => <th key={h.months} className="py-1 text-right font-semibold">{h.months} {t.insights.months}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {(["CONSERVATIVE", "BASE", "AGGRESSIVE"] as const).map((sc) => (
                    <tr key={sc} className="border-t border-border/40">
                      <td className="py-1.5 text-muted-foreground">{t.insights.scenario[sc]}</td>
                      {f.scenarios[sc].horizons.map((h) => <td key={h.months} className={cn("py-1.5 text-right font-mono tabular-nums", Number(h.closingCash) < 0 && "text-red-300")}>{money(h.closingCash)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-muted-foreground">{f.uncertainty.note}</p>
            </div>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-xl font-black uppercase italic">{t.insights.alerts}</h2>
          {badge(alerts.completeness)}
          {findings.dataSufficiency.currentPeriodHasData && (a.length > 0 || findings.opportunities.length > 0) && (
            <span className="ml-auto"><AskAiButton prompt={explainPrompt} configured={configured} label={t.explain} /></span>
          )}
        </div>
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card/60 p-4">
          {!findings.dataSufficiency.currentPeriodHasData ? (
            <p className="text-sm text-muted-foreground">{t.insufficient}</p>
          ) : a.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.insights.noAlerts}</p>
          ) : (
            a.slice(0, 8).map((x, i) => (
              <div key={`${x.code}-${i}`} className="flex items-start gap-3 border-t border-border/40 pt-2 first:border-0 first:pt-0">
                <ShieldAlert className={cn("mt-0.5 size-4 shrink-0", x.severity === "high" ? "text-red-400" : x.severity === "medium" ? "text-amber-300" : "text-muted-foreground")} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {t.alert[x.code]}
                    {x.subject && <span className="text-muted-foreground"> · {x.subject.name}</span>}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">{t.severity[x.severity]}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{x.rule}</p>
                </div>
              </div>
            ))
          )}
          <div className="mt-1 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
            {alerts.sources.map((src) => (
              <Link key={src.href} href={src.href} className="rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/60 hover:text-primary">{src.label}</Link>
            ))}
          </div>
        </div>
        {findings.dataSufficiency.currentPeriodHasData && (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card/60 p-4">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Lightbulb className="size-4 text-primary" /> {t.opportunity.title}
              <span className="ml-auto text-[10px] font-normal normal-case tracking-normal">{t.opportunity.scenario}</span>
            </p>
            {findings.opportunities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.opportunity.none}</p>
            ) : (
              findings.opportunities.slice(0, 5).map((o, i) => (
                <div key={`${o.code}-${o.subject.id}-${i}`} className="flex items-start justify-between gap-3 border-t border-border/40 pt-2 first:border-0 first:pt-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t.opportunity[o.code]} <span className="text-muted-foreground">· {o.subject.name}</span></p>
                    <p className="text-xs text-muted-foreground">{o.basis}</p>
                  </div>
                  <p className="shrink-0 text-right font-mono text-sm text-emerald-300" title={t.opportunity.impact}>+{money(o.estimatedImpact)}</p>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
      {findings.dataSufficiency.currentPeriodHasData && <Recommendations items={findings.recommendations} t={t} money={money} />}
    </div>
  )
}

function kpiValue(v: string | number | null, unit: NonNullable<Recommendation["kpi"]>["unit"], money: (v: string | null) => string) {
  if (v === null || v === undefined) return "—"
  if (unit === "money") return money(String(v))
  if (unit === "pct") return `${Number(v).toFixed(1)}%`
  return String(Number(v).toFixed(unit === "days" ? 0 : 1))
}

/** Prioritized actions from the rules: what to do, the calculated effect, its assumption and the KPI to track. */
function Recommendations({ items, t, money }: { items: Recommendation[]; t: AiTexts; money: (v: string | null | undefined) => string }) {
  const R = t.recommendations
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-xl font-black uppercase italic">{R.title}</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">{R.calculated}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{R.none}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {items.slice(0, 6).map((r) => {
            const title = r.source.kind === "alert" ? t.alert[r.source.code as Alert["code"]] : t.opportunity[r.source.code as Opportunity["code"]]
            const action = r.source.kind === "alert" ? t.reportPage.action[r.source.code as Alert["code"]] : t.opportunityAction[r.source.code]
            return (
              <li key={`${r.priority}-${r.source.code}`} className="grid gap-x-4 gap-y-1 border-t border-border/40 pt-2 first:border-0 first:pt-0 md:grid-cols-[minmax(0,1fr)_200px]">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    <span className={cn("mr-2 inline-flex size-5 items-center justify-center rounded-full text-[11px] font-bold", r.severity === "high" ? "bg-red-500/20 text-red-300" : "bg-primary/15 text-primary")}>{r.priority}</span>
                    {title}
                    {r.subject && <span className="text-muted-foreground"> · {r.subject.name}</span>}
                  </p>
                  <p className="text-xs text-foreground/80">{action}</p>
                  <p className="text-[11px] text-muted-foreground">{R.assumption}: {t.assumption[r.assumption]}</p>
                </div>
                <div className="flex flex-col gap-0.5 text-xs md:text-right">
                  <p>
                    <span className="text-muted-foreground">{R.effect}: </span>
                    {r.impact ? <span className="font-mono text-emerald-300">+{money(r.impact.amount)} <span className="font-sans text-[10px] text-muted-foreground">{r.impact.kind === "cash" ? R.cash : R.profit}</span></span> : <span className="text-muted-foreground">{R.notQuantified}</span>}
                  </p>
                  {r.kpi && (
                    <p className="text-muted-foreground">
                      {R.kpi}: {t.metric[r.kpi.metric] ?? r.kpi.metric} <span className="font-mono text-foreground/80">{kpiValue(r.kpi.current, r.kpi.unit, money)} → {kpiValue(r.kpi.target, r.kpi.unit, money)}</span>
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
