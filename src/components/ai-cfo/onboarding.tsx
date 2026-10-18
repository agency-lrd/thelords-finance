import { CheckCircle2, Circle, Rocket } from "lucide-react"
import Link from "next/link"
import { cn } from "cn"

import type { booksStatus } from "@/lib/ai/onboarding"
import { aiTexts } from "@/lib/i18n/ai-cfo"
import type { Locale } from "@/lib/i18n/format"

/** Shown instead of figures while the books have no posted records: what to fill in, and where. */
export function Onboarding({ status, locale }: { status: Awaited<ReturnType<typeof booksStatus>>; locale: Locale }) {
  const t = aiTexts[locale].onboarding
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-primary/40 bg-card/60 p-5">
      <h2 className="flex items-center gap-2 font-display text-xl font-black uppercase italic"><Rocket className="size-5 text-primary" /> {t.title}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{t.text}</p>
      {status.draftTransactions > 0 && (
        <p className="text-sm text-amber-300">
          {t.drafts.replace("{n}", String(status.draftTransactions))} <Link href="/transactions?status=DRAFT" className="underline-offset-4 hover:underline">{t.open} →</Link>
        </p>
      )}
      <ol className="grid gap-2 md:grid-cols-2">
        {status.steps.map((s) => (
          <li key={s.key} className={cn("flex items-center gap-3 rounded-xl border px-3 py-2", s.done ? "border-border/50 text-muted-foreground" : "border-border")}>
            {s.done ? <CheckCircle2 className="size-4 shrink-0 text-emerald-400" /> : <Circle className="size-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 text-sm">{t.steps[s.key]}</span>
            {s.done ? <span className="text-[11px]">{t.done}</span> : <Link href={s.href} className="text-xs font-medium text-primary hover:underline">{t.open} →</Link>}
          </li>
        ))}
      </ol>
    </section>
  )
}
