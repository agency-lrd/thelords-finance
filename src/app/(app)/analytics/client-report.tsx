import { cn } from "cn"

import type { clientReport } from "@/lib/data/cash-register"
import { formatAmount, type Locale } from "@/lib/i18n/format"

type Report = Awaited<ReturnType<typeof clientReport>>

const T = {
  ru: {
    title: "Клиенты за месяц",
    hint: "Получено денег — реальные оплаты клиентов. Бюджеты — рекламные деньги клиентов, которые проходят транзитом и не являются доходом. Выручка — признанный доход агентства. Это разные цифры, и они не смешиваются.",
    top: "Топ рекламодателей",
    categories: "По категориям клиентов",
    name: "Клиент",
    category: "Категория",
    cash: "Получено денег",
    budgets: "Бюджеты (транзит)",
    revenue: "Выручка",
    empty: "Нет поступлений от клиентов за этот месяц.",
  },
  en: {
    title: "Clients for the month",
    hint: "Cash received: actual client payments. Budgets: client ad money passing through, not income. Revenue: the agency's recognized income. Different figures, never mixed.",
    top: "Top advertisers",
    categories: "By client category",
    name: "Client",
    category: "Category",
    cash: "Cash received",
    budgets: "Budgets (pass-through)",
    revenue: "Revenue",
    empty: "No client receipts this month.",
  },
}

export function ClientReport({ locale, currency, data }: { locale: Locale; currency: string; data: Report }) {
  const t = T[locale]
  const money = (v: string) => formatAmount(v, currency, locale)
  const top = [...data.clients].sort((a, b) => Number(b.cash) + Number(b.budgets) - (Number(a.cash) + Number(a.budgets)) || Number(b.revenue) - Number(a.revenue)).slice(0, 10)
  const table = (title: string, rows: { key: string; name: string; category?: string; cash: string; budgets: string; revenue: string }[], withCategory: boolean) => (
    <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
      <p className="px-3 pt-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <tr>{[t.name, ...(withCategory ? [t.category] : []), t.cash, t.budgets, t.revenue].map((h, i) => <th key={h} className={cn("px-3 py-2 font-medium", i >= (withCategory ? 2 : 1) ? "text-right" : "text-left")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-5 text-center text-muted-foreground">{t.empty}</td></tr>}
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border/50">
              <td className="px-3 py-2">{r.name}</td>
              {withCategory && <td className="px-3 py-2 text-muted-foreground">{r.category}</td>}
              <td className="px-3 py-2 text-right font-mono">{money(r.cash)}</td>
              <td className="px-3 py-2 text-right font-mono text-muted-foreground">{money(r.budgets)}</td>
              <td className="px-3 py-2 text-right font-mono">{money(r.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <section className="flex flex-col gap-3">
      <div className="max-w-3xl">
        <h2 className="font-display text-2xl font-black uppercase italic">{t.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        {table(t.top, top, true)}
        {table(t.categories, data.categories, false)}
      </div>
    </section>
  )
}
