import { CircleCheck, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"
import { Suspense } from "react"
import { cn } from "cn"

import { DrillLabel } from "@/components/reports/drill"
import { ReportHeader } from "@/components/reports/report-header"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/form-controls"
import { requirePageAccess } from "@/lib/auth/session"
import { fill } from "@/lib/i18n/dictionaries"
import { formatAmount } from "@/lib/i18n/format"
import { reportTexts } from "@/lib/i18n/reports"
import { getDictionary } from "@/lib/i18n/server"
import { balanceSheetReport } from "@/lib/reports/ledger"
import type { BalanceGroupKey } from "@/lib/reports/statements"

export const metadata: Metadata = { title: "Баланс" }

export default function BalanceSheetPage({ searchParams }: PageProps<"/balance-sheet">) {
  return (
    <Suspense fallback={<PageSkeleton title="Баланс" />}>
      <BalanceSheet searchParams={searchParams} />
    </Suspense>
  )
}

async function BalanceSheet({ searchParams }: { searchParams: PageProps<"/balance-sheet">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = reportTexts[locale]
  const params = await searchParams
  const raw = typeof params.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.d) ? params.d : new Date().toISOString().slice(0, 10)
  const asOf = new Date(`${raw}T00:00:00Z`)
  const { sheet } = await balanceSheetReport(user, asOf)
  const money = (v: string) => formatAmount(v, user.baseCurrency, locale)
  const period = String(asOf.getUTCFullYear())

  const group = ({ k, title }: { k: BalanceGroupKey; title: string }) => {
    const g = sheet.groups[k]
    return (
      <>
        <tr>
          <td className="py-1.5 pr-4 pl-6 text-foreground/90">{title}</td>
          <td className={cn("px-4 py-1.5 text-right font-mono", g.total === "0" && "text-muted-foreground/60")}>{money(g.total)}</td>
        </tr>
        {g.lines.map((l) => (
          <tr key={l.accountId} className="text-[13px] text-muted-foreground">
            <td className="py-1 pr-4 pl-12">
              <DrillLabel accountId={l.accountId} name={l.name} period={period} currency={user.baseCurrency} asOf={raw}>
                <span className="mr-2 font-mono text-xs">{l.code}</span>
                {l.name}
              </DrillLabel>
            </td>
            <td className="px-4 py-1 text-right font-mono">{money(l.amount)}</td>
          </tr>
        ))}
      </>
    )
  }
  const head = ({ title }: { title: string }) => (
    <tr className="border-t border-border/60">
      <td colSpan={2} className="px-4 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{title}</td>
    </tr>
  )
  const sub = ({ title, value }: { title: string; value: string }) => (
    <tr className="border-t border-border/40 bg-white/[0.02]">
      <td className="px-4 py-2 font-medium">{title}</td>
      <td className="px-4 py-2 text-right font-mono font-semibold">{money(value)}</td>
    </tr>
  )
  const total = ({ title, value }: { title: string; value: string }) => (
    <tr className="border-t border-primary/50 bg-[#3a0d29] text-white">
      <td className="px-4 py-3 font-display font-black uppercase italic">{title}</td>
      <td className="px-4 py-3 text-right font-mono font-semibold">{money(value)}</td>
    </tr>
  )
  const plain = ({ title, value }: { title: string; value: string }) => (
    <tr>
      <td className="py-1.5 pr-4 pl-6 text-foreground/90">{title}</td>
      <td className="px-4 py-1.5 text-right font-mono">{money(value)}</td>
    </tr>
  )

  return (
    <div className="flex flex-col gap-6">
      <ReportHeader
        title={t.bs.title}
        description={t.bs.description}
        actions={
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="bs-date" className="text-xs text-muted-foreground">{t.bs.asOf}</label>
            <Input id="bs-date" type="date" name="d" defaultValue={raw} className="h-8 w-44" />
            <Button type="submit" variant="outline" size="sm">{t.filters.apply}</Button>
          </form>
        }
      />
      <p className={cn("flex items-center gap-2 rounded-xl border px-4 py-3 text-sm", sheet.balanced ? "border-emerald-500/30 text-emerald-300/90" : "border-red-500/50 bg-red-500/10 text-red-200")}>
        {sheet.balanced ? <CircleCheck className="size-4" /> : <TriangleAlert className="size-4" />}
        {sheet.balanced ? `${t.bs.balanced}: ${money(sheet.totalAssets)}` : fill(t.bs.notBalanced, { amount: money(sheet.difference) })}
      </p>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="overflow-hidden rounded-2xl bg-card/50 ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <tbody>
              {head({ title: t.bs.currentAssets })}
              {group({ k: "cash", title: t.bs.cash })}
              {group({ k: "receivables", title: t.bs.receivables })}
              {group({ k: "prepayments", title: t.bs.prepayments })}
              {group({ k: "otherCurrentAssets", title: t.bs.otherCurrentAssets })}
              {sub({ title: t.bs.currentAssets, value: sheet.currentAssets })}
              {head({ title: t.bs.nonCurrentAssets })}
              {group({ k: "fixedAssets", title: t.bs.fixedAssets })}
              {group({ k: "intangibleAssets", title: t.bs.intangibleAssets })}
              {group({ k: "otherNonCurrentAssets", title: t.bs.otherNonCurrentAssets })}
              {sub({ title: t.bs.nonCurrentAssets, value: sheet.nonCurrentAssets })}
              {total({ title: t.bs.totalAssets, value: sheet.totalAssets })}
            </tbody>
          </table>
        </div>
        <div className="overflow-hidden rounded-2xl bg-card/50 ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <tbody>
              {head({ title: t.bs.currentLiabilities })}
              {group({ k: "payables", title: t.bs.payables })}
              {group({ k: "payrollPayable", title: t.bs.payrollPayable })}
              {group({ k: "taxLiabilities", title: t.bs.taxLiabilities })}
              {group({ k: "shortTermLoans", title: t.bs.shortTermLoans })}
              {group({ k: "otherCurrentLiabilities", title: t.bs.otherCurrentLiabilities })}
              {sub({ title: t.bs.currentLiabilities, value: sheet.currentLiabilities })}
              {head({ title: t.bs.longTermLiabilities })}
              {group({ k: "longTermLoans", title: t.bs.longTermLoans })}
              {sub({ title: t.bs.longTermLiabilities, value: sheet.longTermLiabilities })}
              {head({ title: t.bs.equity })}
              {group({ k: "ownerCapital", title: t.bs.ownerCapital })}
              {group({ k: "distributions", title: t.bs.distributions })}
              {plain({ title: t.bs.retainedEarnings, value: sheet.retainedEarnings })}
              {plain({ title: t.bs.currentPeriodProfit, value: sheet.currentPeriodProfit })}
              {sub({ title: t.bs.equity, value: sheet.totalEquity })}
              {total({ title: t.bs.totalLiabilitiesEquity, value: sheet.totalLiabilitiesAndEquity })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
