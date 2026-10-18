"use client"

import { Sparkles } from "lucide-react"
import { useActionState } from "react"

import { saveTargetsAction } from "@/app/(app)/ai-cfo/actions"
import { Input } from "@/components/ui/form-controls"
import { aiTexts } from "@/lib/i18n/ai-cfo"
import { useI18n } from "@/lib/i18n/client"

export const ASK_EVENT = "ai-cfo:ask"

/** Sends a prepared question to the AI CFO chat on this page. */
export function AskAiButton({ prompt, configured, label }: { prompt: string; configured: boolean; label: string }) {
  const { locale } = useI18n()
  return (
    <button
      type="button"
      disabled={!configured}
      title={configured ? undefined : aiTexts[locale].notConfigured}
      onClick={() => window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: prompt }))}
      className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
    >
      <Sparkles className="size-3.5" /> {label}
    </button>
  )
}

type Values = { netProfitMonthly: string | null; revenueMonthly: string | null; ebitdaMarginPct: string | null; cashReserveMonths: string | null }

/** Target inputs (only for roles that may change them). */
export function TargetsForm({ values }: { values: Values }) {
  const { locale } = useI18n()
  const t = aiTexts[locale].targets
  const [state, action, pending] = useActionState(saveTargetsAction, { ok: true as boolean, message: "" })
  const fields: [keyof Values, string, string][] = [
    ["netProfitMonthly", t.netProfitMonthly, "50000"],
    ["revenueMonthly", t.revenueMonthly, "100000"],
    ["ebitdaMarginPct", t.ebitdaMarginPct, "30"],
    ["cashReserveMonths", t.cashReserveMonths, "6"],
  ]
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {fields.map(([name, label, placeholder]) => (
        <label key={name} className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {label}
          <Input name={name} defaultValue={values[name] ?? ""} placeholder={placeholder} inputMode="decimal" className="h-8" />
        </label>
      ))}
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={pending} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50">
          {t.save}
        </button>
        {state.message && <span className={state.ok ? "text-xs text-muted-foreground" : "text-xs text-red-300"}>{state.ok ? t.saved : state.message}</span>}
      </div>
    </form>
  )
}
