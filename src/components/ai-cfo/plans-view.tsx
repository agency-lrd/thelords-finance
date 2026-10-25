"use client"

import { Archive, ArchiveRestore, Lock, Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { archivePlanAction, savePlanAction, type PlanForm } from "@/app/(app)/ai-cfo/actions"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/form-controls"
import type { plansWithActuals } from "@/lib/data/plans"
import { formatAmount, type Locale } from "@/lib/i18n/format"

type Plan = Awaited<ReturnType<typeof plansWithActuals>>[number]
type RowKey = keyof Plan["rows"]

const T = {
  ru: {
    title: "Финансовые планы и сценарии",
    hint: "Планирование бюджета, найма, зарплат, выручки, прибыли и остатка денег на месяц. «Зафиксировать план» сохраняет его без права изменения — потом его можно сравнивать с фактом. План никогда не меняет реальные записи.",
    add: "Новый план",
    name: "Название сценария",
    month: "Месяц",
    assumptions: "Допущения",
    revenue: "Выручка",
    directCosts: "Прямые расходы",
    operatingExpenses: "Операционные расходы",
    payroll: "Зарплаты",
    hiringCost: "Найм (новые сотрудники)",
    profit: "Ожидаемая прибыль",
    profitHint: "пусто — посчитаем: выручка − расходы − зарплаты − найм",
    cashBalance: "Ожидаемый остаток денег",
    saveDraft: "Сохранить черновик",
    fix: "Зафиксировать план",
    fixed: "Зафиксирован",
    draft: "Черновик",
    plan: "План",
    actual: "Факт",
    variance: "Отклонение",
    none: "Планов на этот месяц пока нет.",
    archive: "В архив",
    restore: "Вернуть",
    cancel: "Отмена",
    by: "кем",
  },
  en: {
    title: "Financial plans and scenarios",
    hint: "Plan the month's budget, hiring, payroll, revenue, profit and cash. \"Fix plan\" saves it unchangeable so it can be compared with actuals. A plan never changes real records.",
    add: "New plan",
    name: "Scenario name",
    month: "Month",
    assumptions: "Assumptions",
    revenue: "Revenue",
    directCosts: "Direct costs",
    operatingExpenses: "Operating expenses",
    payroll: "Payroll",
    hiringCost: "Hiring (new people)",
    profit: "Expected profit",
    profitHint: "empty: revenue − costs − payroll − hiring",
    cashBalance: "Expected cash balance",
    saveDraft: "Save draft",
    fix: "Fix plan",
    fixed: "Fixed",
    draft: "Draft",
    plan: "Plan",
    actual: "Actual",
    variance: "Variance",
    none: "No plans for this month yet.",
    archive: "Archive",
    restore: "Restore",
    cancel: "Cancel",
    by: "by",
  },
}

const ROWS: RowKey[] = ["revenue", "directCosts", "operatingExpenses", "payroll", "profit", "cashBalance"]
const COST: RowKey[] = ["directCosts", "operatingExpenses", "payroll"]

export function PlansView(props: { locale: Locale; monthKey: string; currency: string; plans: Plan[]; canEdit: boolean }) {
  const t = T[props.locale]
  const router = useRouter()
  const [, start] = useTransition()
  const empty: PlanForm = { id: "", name: "", month: props.monthKey, assumptions: "", revenue: "", directCosts: "", operatingExpenses: "", payroll: "", hiringCost: "", profit: "", cashBalance: "" }
  const [form, setForm] = useState<PlanForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const money = (v: string | null) => (v === null ? "—" : formatAmount(v, props.currency, props.locale))

  async function save(fix: boolean) {
    if (!form) return
    setBusy(true)
    const r = await savePlanAction(form, fix)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setError(null)
    setForm(null)
    start(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="font-display text-xl font-black uppercase">{t.title}</h2>
          <p className="text-xs text-muted-foreground">{t.hint}</p>
        </div>
        {props.canEdit && !form && <Button size="sm" onClick={() => setForm(empty)}><Plus /> {t.add}</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {form && (
        <div className="grid gap-3 rounded-xl border border-primary/30 p-4 sm:grid-cols-3">
          {([["name", t.name], ["month", t.month]] as const).map(([k, label]) => (
            <label key={k} className="flex flex-col gap-1 text-[11px] text-muted-foreground">{label}<Input type={k === "month" ? "month" : "text"} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="h-8" maxLength={120} /></label>
          ))}
          {(["revenue", "directCosts", "operatingExpenses", "payroll", "hiringCost", "profit", "cashBalance"] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t[k]}
              <Input inputMode="decimal" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="h-8 font-mono" placeholder={k === "profit" ? t.profitHint : ""} />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground sm:col-span-3">{t.assumptions}<Textarea rows={2} value={form.assumptions} onChange={(e) => setForm({ ...form, assumptions: e.target.value })} maxLength={4000} /></label>
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button size="sm" disabled={busy || !form.name.trim()} onClick={() => save(true)}><Lock /> {t.fix}</Button>
            <Button size="sm" variant="outline" disabled={busy || !form.name.trim()} onClick={() => save(false)}>{t.saveDraft}</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>{t.cancel}</Button>
          </div>
        </div>
      )}
      {props.plans.length === 0 && !form && <p className="text-sm text-muted-foreground">{t.none}</p>}
      {props.plans.map((p) => (
        <div key={p.id} className={cn("overflow-x-auto rounded-xl ring-1 ring-foreground/10", p.archived && "opacity-60")}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <p className="font-semibold">
              {p.name}{" "}
              <span className={cn("ml-2 rounded-full border px-2 py-0.5 text-[10px]", p.fixedAt ? "border-primary/50 text-primary" : "border-border text-muted-foreground")}>
                {p.fixedAt ? `${t.fixed} ${p.fixedAt.slice(0, 10)}${p.fixedBy ? ` · ${t.by} ${p.fixedBy}` : ""}` : t.draft}
              </span>
            </p>
            <span className="flex gap-1">
              {!p.fixedAt && props.canEdit && <Button size="sm" variant="ghost" onClick={() => setForm({ id: p.id, name: p.name, month: props.monthKey, assumptions: p.assumptions ?? "", revenue: p.rows.revenue.plan ?? "", directCosts: p.rows.directCosts.plan ?? "", operatingExpenses: p.rows.operatingExpenses.plan ?? "", payroll: p.rows.payroll.plan ?? "", hiringCost: p.hiringCost ?? "", profit: p.rows.profit.plan ?? "", cashBalance: p.rows.cashBalance.plan ?? "" })}>✎</Button>}
              {props.canEdit && <Button size="sm" variant="ghost" onClick={async () => { const r = await archivePlanAction(p.id, !p.archived); if (!r.ok) setError(r.message); else start(() => router.refresh()) }}>{p.archived ? <ArchiveRestore /> : <Archive />}</Button>}
            </span>
          </div>
          {p.assumptions && <p className="px-3 pb-2 text-xs whitespace-pre-wrap text-muted-foreground">{p.assumptions}</p>}
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-white/[0.03] text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              <tr>{["", t.plan, t.actual, t.variance, "%"].map((h, i) => <th key={i} className={cn("px-3 py-1.5 font-medium", i ? "text-right" : "text-left")}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {ROWS.map((k) => {
                const r = p.rows[k]
                const good = r.variance === null ? null : COST.includes(k) ? Number(r.variance) <= 0 : Number(r.variance) >= 0
                return (
                  <tr key={k} className="border-t border-border/40">
                    <td className="px-3 py-1.5">{t[k]}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{money(r.plan)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{money(r.actual)}</td>
                    <td className={cn("px-3 py-1.5 text-right font-mono", good === null ? "" : good ? "text-emerald-300" : "text-red-300")}>{money(r.variance)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{r.variancePct === null ? "—" : `${r.variancePct}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
