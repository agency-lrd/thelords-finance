import { Suspense } from "react"

import { Brand } from "@/components/layout/brand"
import { LocaleSwitch } from "@/components/layout/locale-switch"
import { TopNav } from "@/components/layout/top-nav"
import { signOut } from "@/lib/auth/actions"
import { getSession } from "@/lib/auth/session"
import { getDictionary } from "@/lib/i18n/server"

export function AppHeader() {
  return (
    <header data-print-hide className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 pt-4 sm:px-8">
        <div className="flex items-center gap-4">
          <Brand />
          <div className="ml-auto flex items-center gap-3">
            <LocaleSwitch />
            <Suspense fallback={<span className="h-8 w-32 animate-pulse rounded-full bg-muted/40" />}>
              <CurrentUser />
            </Suspense>
          </div>
        </div>
        <TopNav />
      </div>
    </header>
  )
}

async function CurrentUser() {
  const session = await getSession()
  if (session.state !== "ok") return null
  const { t } = await getDictionary()
  const { user } = session
  return (
    <>
      {user.isSuperAdmin && <span className="hidden rounded-full border border-primary/40 px-2.5 py-1 text-[11px] text-primary md:inline">Super Admin</span>}
      <span className="hidden max-w-48 truncate text-[15px] text-foreground/80 sm:inline">{user.displayName ?? user.email}</span>
      <form action={signOut}>
        <button type="submit" className="rounded-full border border-border px-4 py-1.5 text-[15px] text-foreground/85 transition-colors hover:border-primary/60 hover:text-primary">
          {t.common.signOut}
        </button>
      </form>
    </>
  )
}
