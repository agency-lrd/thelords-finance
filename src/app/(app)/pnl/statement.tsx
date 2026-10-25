"use client"

import Decimal from "decimal.js"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import { cn } from "cn"

import { DrillLabel } from "@/components/reports/drill"
import { InfoTip } from "@/components/reports/info"
import { formatAmount, type Locale } from "@/lib/i18n/format"
import { reportTexts } from "@/lib/i18n/reports"
import { accountLabel } from "@/lib/reports/account-names"
import { growth, percent, type Pnl, type PnlSectionKey } from "@/lib/reports/statements"

type Budget = { metrics: Record<string, string | null>; accounts: Record<string, string> }

type Props = {
  locale: Locale
  currency: string
  period: string
  filters: { departmentId: string | null; clientId: string | null }
  current: Pnl
  previous: Pnl
  yearAgo: Pnl
  budget: Budget | null
}

/** P&L with expandable sections, comparisons and drill-down on every account line. */
export function PnlStatement(props: Props) {
  const { locale, currency, current, previous, yearAgo, budget } = props
  const t = reportTexts[locale]
  const [collapsed, setCollapsed] = useState<Set<PnlSectionKey>>(new Set())
  const money = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatAmount(v, currency, locale))
  const pct = (v: string | null) => (v === null ? "—" : `${v}%`)
  const showBudget = !!budget

  const cells = ({ cur, prev, ago, bud, strong }: { cur: string; prev: string; ago: string; bud?: string | null; strong?: boolean }) => (
    <>
      <td className={cn("px-3 py-2 text-right font-mono", strong && "font-semibold text-foreground")}>{money(cur)}</td>
      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">{pct(percent(cur, current.revenue))}</td>
      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{money(prev)}</td>
      <td className={cn("px-3 py-2 text-right font-mono text-xs", tone(growth(cur, prev)))}>{pct(growth(cur, prev))}</td>
      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{money(ago)}</td>
      <td className={cn("px-3 py-2 text-right font-mono text-xs", tone(growth(cur, ago)))}>{pct(growth(cur, ago))}</td>
      {showBudget && (
        <>
          <td className="px-3 py-2 text-right font-mono text-muted-foreground">{money(bud ?? null)}</td>
          <td className="px-3 py-2 text-right font-mono text-xs">{bud ? money(new Decimal(cur).sub(bud).toString()) : "—"}</td>
        </>
      )}
    </>
  )

  const section = ({ k, title, totalTitle }: { k: PnlSectionKey; title: string; totalTitle?: string }) => {
    const accounts = new Map<string, { code: string; name: string }>()
    for (const p of [current, previous, yearAgo]) for (const l of p.sections[k].lines) accounts.set(l.accountId, { code: l.code, name: l.name })
    if (accounts.size === 0 && !totalTitle) return null
    const amount = (p: Pnl, id: string) => p.sections[k].lines.find((l) => l.accountId === id)?.amount ?? "0"
    const open = !collapsed.has(k)
    return (
      <>
        <tr className="border-t border-border/60">
          <td className="px-3 pt-4 pb-1.5" colSpan={showBudget ? 9 : 7}>
            <button type="button" onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {title}
            </button>
          </td>
        </tr>
        {open &&
          [...accounts.entries()].sort((a, b) => a[1].code.localeCompare(b[1].code)).map(([id, a]) => (
            <tr key={id} className="hover:bg-white/[0.02]">
              <td className="py-1.5 pr-3 pl-8">
                <DrillLabel accountId={id} name={accountLabel(a.code, a.name, locale)} period={props.period} filters={props.filters} currency={currency}>
                  {accountLabel(a.code, a.name, locale)}
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground/60">{a.code}</span>
                </DrillLabel>
              </td>
              {cells({ cur: amount(current, id), prev: amount(previous, id), ago: amount(yearAgo, id), bud: budget?.accounts[id] })}
            </tr>
          ))}
        {totalTitle && (
          <tr className="border-t border-border/40">
            <td className="px-3 py-2 font-medium">{totalTitle}</td>
            {cells({ cur: current.sections[k].total, prev: previous.sections[k].total, ago: yearAgo.sections[k].total, bud: sectionBudget(k, budget), strong: true })}
          </tr>
        )}
      </>
    )
  }

  const total = ({ title, info, k, margin }: { title: string; info?: readonly string[]; k: "grossProfit" | "ebitda" | "ebit" | "profitBeforeTax" | "netProfit"; margin?: string | null }) => (
    <tr className={cn("border-t", k === "netProfit" ? "border-primary/50 bg-[#3a0d29] text-white" : "border-border bg-white/[0.03]")}>
      <td className="px-3 py-2.5 font-display text-sm font-black uppercase italic">
        <span className="mr-1.5">{title}</span>
        {info && <InfoTip text={info[1]} />}
        {margin !== undefined && <span className="ml-2 font-sans text-xs font-normal normal-case not-italic text-muted-foreground">{t.pnl.margin} {margin === null ? "—" : `${margin}%`}</span>}
      </td>
      {cells({ cur: current[k], prev: previous[k], ago: yearAgo[k], bud: k === "ebitda" ? budget?.metrics.EBITDA : k === "netProfit" ? budget?.metrics.NET_PROFIT : null, strong: true })}
    </tr>
  )

  const empty = current.revenue === "0" && current.totalExpenses === "0"
  return (
    <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          <tr>
            <th className="px-3 py-2.5 text-left font-medium" />
            <th className="px-3 py-2.5 text-right font-medium">{t.compare.current}</th>
            <th className="px-3 py-2.5 text-right font-medium">%</th>
            <th className="px-3 py-2.5 text-right font-medium">{t.compare.previous}</th>
            <th className="px-3 py-2.5 text-right font-medium">Δ</th>
            <th className="px-3 py-2.5 text-right font-medium">{t.compare.yearAgo}</th>
            <th className="px-3 py-2.5 text-right font-medium">Δ</th>
            {showBudget && (
              <>
                <th className="px-3 py-2.5 text-right font-medium">{t.compare.budget}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t.compare.variance}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {empty && (
            <tr>
              <td colSpan={showBudget ? 9 : 7} className="px-3 py-6 text-center text-muted-foreground">{t.pnl.empty}</td>
            </tr>
          )}
          {section({ k: "revenue", title: t.pnl.revenue, totalTitle: t.pnl.totalRevenue })}
          {section({ k: "costOfServices", title: t.pnl.costOfServices, totalTitle: t.pnl.totalCostOfServices })}
          {total({ title: t.pnl.grossProfit, info: t.metrics.grossProfit, k: "grossProfit", margin: current.margins.gross })}
          {section({ k: "operatingExpenses", title: t.pnl.operatingExpenses, totalTitle: t.pnl.totalOperatingExpenses })}
          {total({ title: t.pnl.ebitda, info: t.metrics.ebitda, k: "ebitda", margin: current.margins.ebitda })}
          {section({ k: "depreciation", title: t.pnl.depreciation })}
          {section({ k: "amortization", title: t.pnl.amortization })}
          {total({ title: t.pnl.ebit, info: t.metrics.ebit, k: "ebit", margin: current.margins.ebit })}
          {section({ k: "otherIncome", title: t.pnl.otherIncome })}
          {section({ k: "otherExpense", title: t.pnl.otherExpense })}
          {total({ title: t.pnl.profitBeforeTax, info: t.metrics.profitBeforeTax, k: "profitBeforeTax" })}
          {section({ k: "incomeTax", title: t.pnl.incomeTax })}
          {total({ title: t.pnl.netProfit, info: t.metrics.netProfit, k: "netProfit", margin: current.margins.net })}
        </tbody>
      </table>
    </div>
  )
}

function tone(g: string | null) {
  if (g === null) return "text-muted-foreground"
  return Number(g) >= 0 ? "text-emerald-300/90" : "text-red-300/90"
}

function sectionBudget(k: PnlSectionKey, budget: Budget | null) {
  if (!budget) return null
  return k === "revenue" ? budget.metrics.REVENUE : k === "costOfServices" ? budget.metrics.DIRECT_COSTS : k === "operatingExpenses" ? budget.metrics.OPEX : null
}
