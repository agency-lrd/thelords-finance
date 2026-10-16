import type { Metadata } from "next"
import { Suspense } from "react"

import Link from "next/link"

import { onboardingOpen } from "@/lib/auth/session"
import { getDictionary } from "@/lib/i18n/server"
import { isSupabaseConfigured } from "@/lib/supabase/env"

import { LoginForm } from "./login-form"

export const metadata: Metadata = { title: "Sign in" }

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div>
            <h1 className="font-display text-4xl font-black text-primary italic drop-shadow-[0_0_24px_rgba(236,72,153,0.5)]">THE LORDS</h1>
            <p className="mt-2 font-display text-sm font-extrabold tracking-[0.2em] italic">FINANCE OS</p>
          </div>
        </div>
        <div className="rounded-2xl bg-card/80 p-6 ring-1 ring-foreground/10 backdrop-blur">
          <Suspense>
            <LoginFormWithNext searchParams={searchParams} />
          </Suspense>
        </div>
        <Suspense>
          <Footer />
        </Suspense>
      </div>
    </main>
  )
}

async function LoginFormWithNext({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const params = await searchParams
  const next = typeof params.next === "string" ? params.next : "/"
  return <LoginForm next={next} configured={isSupabaseConfigured()} />
}

async function Footer() {
  const { t } = await getDictionary()
  // The database may be unreachable (e.g. a preview without credentials): then simply hide the link.
  const open = isSupabaseConfigured() ? await onboardingOpen().catch(() => false) : false
  return (
    <div className="mt-6 flex flex-col items-center gap-3 text-center">
      {open && (
        <Link href="/onboarding" className="text-sm text-primary hover:underline">
          {t.auth.firstTime}
        </Link>
      )}
      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">{t.auth.authorizedOnly}</p>
    </div>
  )
}
