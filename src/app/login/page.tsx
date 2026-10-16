import type { Metadata } from "next"
import { Suspense } from "react"

import { siteConfig } from "@/config/site"
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
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-[0_0_40px_-6px_var(--primary)]">
            L
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-[0.24em]">{siteConfig.name}</h1>
            <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{siteConfig.product}</p>
          </div>
        </div>
        <div className="rounded-2xl bg-card/80 p-6 ring-1 ring-foreground/10 backdrop-blur">
          <Suspense>
            <LoginFormWithNext searchParams={searchParams} />
          </Suspense>
        </div>
        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
          Internal · Authorized personnel only
        </p>
      </div>
    </main>
  )
}

async function LoginFormWithNext({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const params = await searchParams
  const next = typeof params.next === "string" ? params.next : "/"
  return <LoginForm next={next} configured={isSupabaseConfigured()} />
}
