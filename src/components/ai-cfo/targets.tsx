import { Target } from "lucide-react"
import { cn } from "cn"

import type { SessionUser } from "@/lib/auth/session"
import { runTool } from "@/lib/ai/tools"
import { getTargets } from "@/lib/data/targets"
import { aiTexts } from "@/lib/i18n/ai-cfo"
import { formatAmount, type Locale } from "@/lib/i18n/format"

import { AskAiButton, TargetsForm } from "./insight-actions"

type Gap = {
  status: string
  baseline?: { months: string[] }
  kpis?: { metric: "netProfitMonthly" | "revenueMonthly" | "ebitdaMarginPct" | "cashReserveMonths"; current: string; target: string; gap: string; reached: boolean }[]
  paths?: { target: string; path: string; values: Record<string, string | number | null>; feasible: boolean; note?: string }[]
}

/** Saved targets, the deterministic gap to actuals, and a button to build a plan with the AI. */
export async function TargetsPanel({ user, locale, configured }: { user: SessionUser; locale: Locale; configured: boolean }) {
  const t = aiTexts[locale]
  const T = t.targets
  const saved = await getTargets(user)
  const result = await runTool(user, "getTargetGapAnalysis", {})
  const gap = result.values as Gap
  const money = (v: string | number | null | undefined) => formatAmount(v === null || v === undefined ? null : String(v), user.baseCurrency, locale, { decimals: 0 })
  const show = (metric: string, v: string) => (metric === "ebitdaMarginPct" ? `${Number(v).toFixed(1)}%` : metric === "cashReserveMonths" ? Number(v).toFixed(1) : money(v))
  const canEdit = user.permissions.has("ledger:manage")
  const planPrompt =
    locale === "ru"
      ? "Построй план достижения наших целей: оцени разрыв с фактом, выбери реалистичные рычаги (выручка, расходы, ФОТ, маржа), посчитай эффект каждого сценарием и дай план действий с допущениями, ожидаемым эффектом и KPI."
      : "Build a plan to reach our targets: assess the gap to actuals, choose realistic levers (revenue, costs, payroll, margin), calculate each lever with a scenario, and give an action plan with assumptions, expected impact and KPIs."
  const pathText = (p: NonNullable<Gap["paths"]>[number]) =>
    Object.entries(p.values)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}: ${typeof v === "number" ? v : money(v)}`)
      .join(" · ")

  return (
    <section id="targets" className="flex scroll-mt-20 flex-col gap-3 rounded-2xl border border-border bg-card/40 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-display text-xl font-black uppercase italic"><Target className="size-5 text-primary" /> {T.title}</h2>
        {gap.status === "ok" && <span className="ml-auto"><AskAiButton prompt={planPrompt} configured={configured} label={T.plan} /></span>}
      </div>
      <p className="text-sm text-muted-foreground">{T.description}</p>
      {canEdit ? <TargetsForm values={saved} /> : <p className="text-xs text-muted-foreground">{T.noRights}</p>}
      {gap.status === "no_targets" && <p className="text-sm text-muted-foreground">{T.none}</p>}
      {gap.status === "insufficient_history" && <p className="text-sm text-muted-foreground">{T.insufficient}</p>}
      {gap.status === "ok" && gap.kpis && (
        <>
          <div className="overflow-x-auto rounded-xl border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold" />
                  <th className="px-3 py-2 text-right font-semibold">{T.current}</th>
                  <th className="px-3 py-2 text-right font-semibold">{T.target}</th>
                  <th className="px-3 py-2 text-right font-semibold">{T.gap}</th>
                </tr>
              </thead>
              <tbody>
                {gap.kpis.map((k) => (
                  <tr key={k.metric} className="border-t border-border/40">
                    <td className="px-3 py-1.5">{T[k.metric]}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{show(k.metric, k.current)}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{show(k.metric, k.target)}</td>
                    <td className={cn("px-3 py-1.5 text-right font-mono tabular-nums", k.reached ? "text-emerald-300" : "text-amber-300")}>{k.reached ? T.reached : show(k.metric, k.gap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {gap.paths && gap.paths.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{T.paths} · {t.opportunity.scenario}</p>
              {gap.paths.map((p, i) => (
                <p key={`${p.target}-${p.path}-${i}`} className={cn("text-xs", p.feasible ? "text-muted-foreground" : "text-muted-foreground/60 line-through decoration-muted-foreground/40")}>
                  <span className="font-medium text-foreground">{T[p.target as keyof typeof T] as string} — {t.pathLabel[p.path as keyof typeof t.pathLabel] ?? p.path}:</span> {pathText(p)}
                  {p.note && <span className="ml-1 text-amber-300">({p.note})</span>}
                </p>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">{T.baseline}: {gap.baseline?.months.join(", ")}</p>
        </>
      )}
    </section>
  )
}
