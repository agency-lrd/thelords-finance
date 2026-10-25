import { cn } from "cn"

import { InfoTip } from "@/components/reports/info"
import { formatAmount, type Locale } from "@/lib/i18n/format"

type Data = {
  rows: { id: string; name: string; revenue: string; directCosts: string; grossProfit: string; margin: string | null }[]
  total: { revenue: string; directCosts: string; grossProfit: string; margin: string | null }
}

const T = {
  ru: {
    title: "Валовая прибыль по направлениям",
    badge: "Фильтр: Influence, Crypto Marketing, Clipping / UBT",
    info: "Отдельный отфильтрованный вид только для трёх направлений. Общий P&L выше включает все отделы (в том числе AI Production) — они не исключаются из консолидированной прибыли.",
    direction: "Направление",
    revenue: "Выручка",
    costs: "Прямые расходы",
    gross: "Валовая прибыль",
    margin: "Валовая маржа",
    total: "Итого по трём направлениям",
  },
  en: {
    title: "Gross profit by direction",
    badge: "Filter: Influence, Crypto Marketing, Clipping / UBT",
    info: "A separate filtered view of three directions only. The company P&L above includes every department (AI Production too): nothing is excluded from consolidated profit.",
    direction: "Direction",
    revenue: "Revenue",
    costs: "Direct costs",
    gross: "Gross profit",
    margin: "Gross margin",
    total: "Total of the three",
  },
}

export function DirectionGross({ locale, currency, data }: { locale: Locale; currency: string; data: Data }) {
  const t = T[locale]
  const money = (v: string) => formatAmount(v, currency, locale)
  const row = (name: string, r: Data["total"], strong = false, key?: string) => (
    <tr key={key ?? name} className={cn("border-t border-border/60", strong && "border-primary/40 font-semibold")}>
      <td className="px-3 py-2">{name}</td>
      <td className="px-3 py-2 text-right font-mono">{money(r.revenue)}</td>
      <td className="px-3 py-2 text-right font-mono">{money(r.directCosts)}</td>
      <td className={cn("px-3 py-2 text-right font-mono", Number(r.grossProfit) < 0 && "text-red-300")}>{money(r.grossProfit)}</td>
      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{r.margin === null ? "—" : `${r.margin}%`}</td>
    </tr>
  )
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-xl font-black uppercase">{t.title}</h2>
        <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[11px] text-primary">{t.badge}</span>
        <InfoTip text={t.info} />
      </div>
      <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            <tr>{[t.direction, t.revenue, t.costs, t.gross, t.margin].map((h, i) => <th key={h} className={cn("px-3 py-2.5 font-medium", i ? "text-right" : "text-left")}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((r) => row(r.name, r, false, r.id))}
            {row(t.total, data.total, true)}
          </tbody>
        </table>
      </div>
    </section>
  )
}
