import { LogOut } from "lucide-react"
import { Suspense } from "react"

import { MobileNav } from "@/components/layout/mobile-nav"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { signOut } from "@/lib/auth/actions"
import { getSession } from "@/lib/auth/session"

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur supports-backdrop-filter:bg-background/60 sm:px-6">
      <MobileNav />
      <div className="ml-auto flex items-center gap-3">
        <Suspense fallback={<span className="h-6 w-40 animate-pulse rounded-md bg-muted/40" />}>
          <CurrentUser />
        </Suspense>
      </div>
    </header>
  )
}

async function CurrentUser() {
  const session = await getSession()
  if (session.state !== "ok") return null
  const { user } = session
  return (
    <>
      <Badge variant="outline" className="hidden gap-1.5 text-muted-foreground sm:inline-flex">
        <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
        {user.organizationName} · {user.baseCurrency}
      </Badge>
      {user.isSuperAdmin && (
        <Badge variant="outline" className="border-primary/40 text-primary">
          Super Admin
        </Badge>
      )}
      <span className="hidden max-w-48 truncate text-sm text-muted-foreground md:inline">{user.displayName ?? user.email}</span>
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out" title="Sign out">
          <LogOut />
        </Button>
      </form>
    </>
  )
}
