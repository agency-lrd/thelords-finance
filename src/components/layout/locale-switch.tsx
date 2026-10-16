"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { cn } from "cn"

import { setLocale } from "@/lib/i18n/actions"
import { useI18n } from "@/lib/i18n/client"

export function LocaleSwitch() {
  const { locale, t } = useI18n()
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <div role="group" aria-label={t.common.language} className={cn("flex rounded-full border border-border p-0.5 text-xs", pending && "opacity-60")}>
      {(["ru", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => start(async () => { await setLocale(l); router.refresh() })}
          className={cn("rounded-full px-2.5 py-1 uppercase", locale === l ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}
        >
          {l}
        </button>
      ))}
    </div>
  )
}
