import { ShieldAlert } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { signOut } from "@/lib/auth/actions"

export const metadata: Metadata = { title: "No access" }

export default function NoAccessPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <ShieldAlert className="size-6" />
        </span>
        <h1 className="text-xl font-semibold">No access</h1>
        <p className="text-sm text-muted-foreground">
          Your account is signed in but has no access to this area of THE LORDS Finance OS. Ask a Super Admin or the
          Owner to grant you a role.
        </p>
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
