"use client"

import { useActionState } from "react"

import { FormMessage } from "@/components/shared/action-form"
import { Button } from "@/components/ui/button"
import { Field, Input } from "@/components/ui/form-controls"
import { signIn } from "@/lib/auth/actions"
import { idleState } from "@/lib/forms"

export function LoginForm({ next, configured }: { next: string; configured: boolean }) {
  const [state, action, pending] = useActionState(signIn, idleState)

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" size="lg" disabled={pending || !configured} className="mt-2 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      {!configured && (
        <p className="text-xs text-muted-foreground">Sign-in is not configured yet. Add the Supabase publishable key.</p>
      )}
      <FormMessage state={state} />
    </form>
  )
}
