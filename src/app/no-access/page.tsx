import { ShieldAlert, Wrench } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { Button } from "@/components/ui/button"
import { signOut } from "@/lib/auth/actions"

export const metadata: Metadata = { title: "No access" }

export default function NoAccessPage({ searchParams }: PageProps<"/no-access">) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <Suspense>
          <Message searchParams={searchParams} />
        </Suspense>
        <div className="flex gap-2">
          <Link href="/" className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted">
            Back to dashboard
          </Link>
          <form action={signOut}>
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </main>
  )
}

const KNOWN = new Set(["DATABASE_URL", "SUPER_ADMIN_EMAIL", "database connection"])

async function Message({ searchParams }: { searchParams: PageProps<"/no-access">["searchParams"] }) {
  const params = await searchParams
  if (params.reason === "setup") {
    // Only known names are echoed back: the query string is user-controlled.
    const missing = String(params.missing ?? "").split(",").filter((m) => KNOWN.has(m))
    return (
      <>
        <span className="flex size-12 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
          <Wrench className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">Setup needed · Требуется настройка</h1>
        <p className="text-sm text-muted-foreground">
          You are signed in, but the server is not fully configured. Add the missing environment variables (for production: Vercel →
          Project → Settings → Environment Variables), redeploy, then reload this page.
        </p>
        {missing.length > 0 && (
          <ul className="flex flex-col gap-1 font-mono text-sm text-amber-200">
            {missing.map((m) => (
              <li key={m}>{m === "database connection" ? "Database connection failed (check DATABASE_URL)" : m}</li>
            ))}
          </ul>
        )}
      </>
    )
  }
  return (
    <>
      <span className="flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <ShieldAlert className="size-6" />
      </span>
      <h1 className="text-xl font-semibold">No access · Нет доступа</h1>
      <p className="text-sm text-muted-foreground">
        Your account is signed in but has no access to this area of THE LORDS Finance OS. Ask a Super Admin or the Owner to
        grant you a role.
      </p>
    </>
  )
}
