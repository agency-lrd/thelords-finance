"use client"

import { useActionState } from "react"

import { FormMessage } from "@/components/shared/action-form"
import { Button } from "@/components/ui/button"
import { Field, Input } from "@/components/ui/form-controls"
import { signUpSuperAdmin } from "@/lib/auth/actions"
import { idleState } from "@/lib/forms"

export function OnboardingForm() {
  const [state, action, pending] = useActionState(signUpSuperAdmin, idleState)
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password" hint="12+ characters">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Button type="submit" size="lg" disabled={pending || state.status === "success"} className="mt-2 w-full">
        {pending ? "…" : "Create account"}
      </Button>
      <FormMessage state={state} />
    </form>
  )
}
