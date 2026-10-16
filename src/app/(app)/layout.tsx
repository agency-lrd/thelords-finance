import { Suspense } from "react"

import { AppHeader } from "@/components/layout/app-header"
import { LocaleProvider } from "@/lib/i18n/client"
import { getLocale } from "@/lib/i18n/server"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <Shell>{children}</Shell>
    </Suspense>
  )
}

async function Shell({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  return (
    <LocaleProvider locale={locale}>
      <div className="relative flex min-h-dvh flex-col">
        {/* Subtle magenta glow behind the header, like THE LORDS BizDev CRM. */}
        <div aria-hidden data-print-hide className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_80%_60%_at_20%_0%,rgba(190,24,93,0.22),transparent_70%)]" />
        <AppHeader />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
    </LocaleProvider>
  )
}
