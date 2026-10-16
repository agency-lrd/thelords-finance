import { Lock, Sparkles, TriangleAlert } from "lucide-react"
import type { Metadata } from "next"
import { Suspense } from "react"
import { cn } from "cn"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { toolsFor, monthSummary } from "@/lib/ai/tools"
import { requirePageAccess } from "@/lib/auth/session"
import { formatAmount } from "@/lib/i18n/format"
import { getDictionary } from "@/lib/i18n/server"

export const metadata: Metadata = { title: "AI CFO" }

export default function AiCfoPage() {
  return (
    <Suspense fallback={<PageSkeleton title="AI CFO" />}>
      <AiCfo />
    </Suspense>
  )
}

const T = {
  ru: {
    description: "Финансовый ассистент, который отвечает только по данным компании через проверяемые расчёты. Он не придумывает цифры и видит только то, что разрешено вашей роли.",
    disabled: "Отключён: ключ AI-провайдера не настроен",
    disabledText: "Чат появится, когда администратор добавит ключ провайдера в переменные окружения сервера. До этого ниже — детерминированная сводка из тех же расчётов, без AI.",
    enabled: "Подключение к AI-провайдеру настроено. Чат будет включён в следующей версии.",
    summary: "Сводка за месяц (расчёт, не AI)",
    revenue: "Выручка",
    ebitda: "EBITDA",
    netProfit: "Чистая прибыль",
    netProfitYtd: "Чистая прибыль с начала года",
    cash: "Остаток денег",
    netCash: "Изменение денег",
    vsPrev: "к прошлому месяцу",
    anomalies: "Отклонения от последних 3 месяцев",
    noAnomalies: "Существенных отклонений нет",
    spike: "рост",
    drop: "снижение",
    new: "новая статья",
    tools: "Инструменты, доступные AI для вашей роли",
    notReconciled: "Cash Flow не сходится с остатками счетов",
  },
  en: {
    description: "A financial assistant that answers only from company data through verifiable calculations. It never invents figures and sees only what your role allows.",
    disabled: "Disabled: AI provider key not configured",
    disabledText: "Chat appears once an administrator adds the provider key to the server environment. Until then, below is a deterministic summary from the same calculations, without AI.",
    enabled: "An AI provider is configured. Chat will be enabled in the next version.",
    summary: "Month summary (calculated, not AI)",
    revenue: "Revenue",
    ebitda: "EBITDA",
    netProfit: "Net profit",
    netProfitYtd: "Net profit year to date",
    cash: "Cash balance",
    netCash: "Cash change",
    vsPrev: "vs last month",
    anomalies: "Deviations from the last 3 months",
    noAnomalies: "No significant deviations",
    spike: "increase",
    drop: "decrease",
    new: "new line",
    tools: "Tools available to the AI for your role",
    notReconciled: "Cash flow does not reconcile with account balances",
  },
}

async function AiCfo() {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = T[locale]
  // Only presence is checked; the key itself is never read into the page.
  const configured = Boolean(process.env.ANTHROPIC_API_KEY)
  const summary = await monthSummary(user)
  const money = (v: string) => formatAmount(v, user.baseCurrency, locale, { decimals: 0 })
  const tools = toolsFor(user)
  const card = (label: string, value: string, sub?: string | null) => (
    <div className="rounded-2xl border border-border bg-card/60 p-5">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-display text-2xl font-black", Number(value) < 0 && "text-red-300")}>{money(value)}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-3 font-display text-3xl font-black uppercase tracking-tight sm:text-4xl"><Sparkles className="size-7 text-primary" /> AI CFO</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
      </div>
      <div className={cn("flex items-start gap-3 rounded-2xl border p-5", configured ? "border-primary/40" : "border-border")}>
        <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">{configured ? t.enabled : t.disabled}</p>
          {!configured && <p className="mt-1 text-sm text-muted-foreground">{t.disabledText}</p>}
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-black uppercase italic">{t.summary} · {summary.period}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {card(t.revenue, summary.revenue, summary.revenueGrowth ? `${summary.revenueGrowth}% ${t.vsPrev}` : null)}
          {card(t.ebitda, summary.ebitda, summary.ebitdaMargin ? `${summary.ebitdaMargin}%` : null)}
          {card(t.netProfit, summary.netProfit, summary.netProfitGrowth ? `${summary.netProfitGrowth}% ${t.vsPrev}` : null)}
          {card(t.netProfitYtd, summary.netProfitYtd)}
          {card(t.cash, summary.closingCash)}
          {card(t.netCash, summary.netCash)}
        </div>
        {!summary.reconciled && <p className="flex items-center gap-2 text-sm text-red-300"><TriangleAlert className="size-4" /> {t.notReconciled}</p>}
        <div className="rounded-2xl border border-border bg-card/60 p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.anomalies}</p>
          {summary.anomalies.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noAnomalies}</p>
          ) : (
            summary.anomalies.map((a) => (
              <div key={a.key} className="flex justify-between gap-3 border-t border-border/40 py-2 text-sm first:border-0">
                <span>{a.name} <span className="text-xs text-muted-foreground">({t[a.reason]}{a.change ? ` ${a.change}%` : ""})</span></span>
                <span className="font-mono">{money(a.value)} <span className="text-xs text-muted-foreground">/ {money(a.baseline)}</span></span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.tools}</h2>
        <div className="grid gap-2 md:grid-cols-2">
          {tools.map((tool) => (
            <div key={tool.name} className="rounded-xl border border-border/60 px-4 py-3">
              <p className="font-mono text-xs text-primary">{tool.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
