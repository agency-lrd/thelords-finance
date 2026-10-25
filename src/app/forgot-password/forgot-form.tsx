"use client"

import { useActionState } from "react"

import { FormMessage } from "@/components/shared/action-form"
import { Button } from "@/components/ui/button"
import { Field, Input } from "@/components/ui/form-controls"
import { requestPasswordReset } from "@/lib/auth/actions"
import { idleState } from "@/lib/forms"

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, idleState)
  return (
    <form action={action} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Введите email своего аккаунта — мы пришлём ссылку для установки нового пароля.</p>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Button type="submit" size="lg" disabled={pending || state.status === "success"} className="w-full">
        {pending ? "Отправляем…" : "Отправить ссылку"}
      </Button>
      <FormMessage state={state} />
    </form>
  )
}
