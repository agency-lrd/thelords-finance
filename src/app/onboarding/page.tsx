import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { onboardingOpen } from "@/lib/auth/session"
import { getDictionary } from "@/lib/i18n/server"
import { isSupabaseConfigured } from "@/lib/supabase/env"

import { OnboardingForm } from "./onboarding-form"

export const metadata: Metadata = { title: "Onboarding" }

export default function OnboardingPage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative w-full max-w-sm">
        <Suspense>
          <Content />
        </Suspense>
      </div>
    </main>
  )
}

async function Content() {
  const { t } = await getDictionary()
  const open = isSupabaseConfigured() && (await onboardingOpen())
  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <p className="font-display text-2xl font-black text-primary italic">THE LORDS</p>
        <h1 className="mt-2 font-display text-lg font-black uppercase">{t.auth.onboardingTitle}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t.auth.onboardingHint}</p>
      </div>
      <div className="rounded-3xl bg-card/80 p-6 ring-1 ring-primary/25 backdrop-blur">
        {open ? <OnboardingForm /> : <p className="text-sm text-muted-foreground">{isSupabaseConfigured() ? "—" : t.auth.notConfigured}</p>}
      </div>
      <Link href="/login" className="text-center text-sm text-muted-foreground hover:text-primary">← {t.auth.signIn}</Link>
    </div>
  )
}
