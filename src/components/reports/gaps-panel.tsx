import { AlertTriangle, CheckCircle2 } from "lucide-react"
import Link from "next/link"

import { formatAmount, type Locale } from "@/lib/i18n/format"

type Gaps = {
  payrollNotApproved: { month: string; employees: number }[]
  plannedIncome: { count: number; amount: string }
  plannedCosts: { count: number; amount: string }
  draftTransactions: { count: number; amount: string }
  incomeNotReceived: { count: number; amount: string }
  costsNotPaid: { count: number; amount: string }
}

const T = {
  ru: {
    title: "Что ещё не учтено в этом отчёте",
    ok: "Все вводные за период учтены.",
    payroll: "Ведомость за {month} не утверждена ({n} сотр.) — зарплата этого месяца ещё не в расходах.",
    plannedIncome: "{n} строк дохода не подтверждены ({amount}) — не входят в выручку.",
    plannedCosts: "{n} строк расходов не подтверждены ({amount}) — не входят в расходы.",
    drafts: "{n} транзакций в черновике ({amount}) — не проведены.",
    notReceived: "Выручка признана, но деньги не получены: {amount} ({n} строк) — в Cash Flow появится после отметки оплаты.",
    notPaid: "Расходы признаны, но не оплачены: {amount} ({n} строк) — в Cash Flow появятся после оплаты.",
  },
  en: {
    title: "Not yet included in this report",
    ok: "All inputs for the period are included.",
    payroll: "Payroll for {month} is not approved ({n} employees): that month's salaries are not in expenses yet.",
    plannedIncome: "{n} income rows not confirmed ({amount}): not in revenue.",
    plannedCosts: "{n} cost rows not confirmed ({amount}): not in expenses.",
    drafts: "{n} draft transactions ({amount}): not posted.",
    notReceived: "Revenue recognized but money not received: {amount} ({n} rows); appears in Cash Flow once marked paid.",
    notPaid: "Costs recognized but not paid: {amount} ({n} rows); appear in Cash Flow once paid.",
  },
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""))

/** Missing or unapproved inputs for a report period, with links to where they are fixed. */
export function GapsPanel({ gaps, locale, currency, focus }: { gaps: Gaps; locale: Locale; currency: string; focus: "pnl" | "cash" }) {
  const t = T[locale]
  const money = (v: string) => formatAmount(v, currency, locale)
  const items: { text: string; href: string }[] = []
  for (const p of gaps.payrollNotApproved) items.push({ text: fill(t.payroll, { month: p.month, n: p.employees }), href: `/payroll?month=${p.month}` })
  if (focus === "pnl") {
    if (gaps.plannedIncome.count) items.push({ text: fill(t.plannedIncome, { n: gaps.plannedIncome.count, amount: money(gaps.plannedIncome.amount) }), href: "/payroll" })
    if (gaps.plannedCosts.count) items.push({ text: fill(t.plannedCosts, { n: gaps.plannedCosts.count, amount: money(gaps.plannedCosts.amount) }), href: "/payroll" })
  }
  if (gaps.draftTransactions.count) items.push({ text: fill(t.drafts, { n: gaps.draftTransactions.count, amount: money(gaps.draftTransactions.amount) }), href: "/transactions?status=DRAFT" })
  if (focus === "cash") {
    if (gaps.incomeNotReceived.count) items.push({ text: fill(t.notReceived, { n: gaps.incomeNotReceived.count, amount: money(gaps.incomeNotReceived.amount) }), href: "/payroll" })
    if (gaps.costsNotPaid.count) items.push({ text: fill(t.notPaid, { n: gaps.costsNotPaid.count, amount: money(gaps.costsNotPaid.amount) }), href: "/payroll" })
  }
  if (items.length === 0) {
    return <p className="flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="size-4" /> {t.ok}</p>
  }
  return (
    <section className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
      <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300"><AlertTriangle className="size-4" /> {t.title}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((i) => (
          <li key={i.text}><Link href={i.href} className="hover:text-primary hover:underline">{i.text}</Link></li>
        ))}
      </ul>
    </section>
  )
}
