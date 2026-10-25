"use client"

import { Eye, EyeOff, Loader2 } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useActionState, useEffect, useState } from "react"

import { FormMessage } from "@/components/shared/action-form"
import { Button } from "@/components/ui/button"
import { Field, Input } from "@/components/ui/form-controls"
import { updatePassword } from "@/lib/auth/actions"
import { parseAuthHash, RECOVERY_MESSAGES, recoveryError, type RecoveryError } from "@/lib/auth/recovery"
import { idleState } from "@/lib/forms"
import { createClient } from "@/lib/supabase/client"

type Status = { state: "checking" } | { state: "ready"; email: string | null } | { state: "error"; error: RecoveryError }

/**
 * "Set a new password". Accepts the recovery session from the auth callback (PKCE / token hash) or from
 * an implicit-flow link (#access_token… in the fragment, turned into a session here and removed from the
 * address bar). Without a valid recovery session it explains what to do instead of failing silently.
 */
export function ResetPasswordForm() {
  const params = useSearchParams()
  const [status, setStatus] = useState<Status>({ state: "checking" })
  const [show, setShow] = useState(false)
  const [state, action, pending] = useActionState(updatePassword, idleState)

  useEffect(() => {
    let alive = true
    const finish = (next: Status) => alive && setStatus(next)
    ;(async () => {
      const queryError = params.get("error")
      const hash = parseAuthHash(window.location.hash)
      // Never leave tokens in the address bar or browser history.
      if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search)
      if (queryError) return finish({ state: "error", error: queryError in RECOVERY_MESSAGES ? (queryError as RecoveryError) : "invalid" })
      if (hash.error) return finish({ state: "error", error: recoveryError(hash.error, hash.errorDescription) })
      const supabase = createClient()
      if (hash.accessToken && hash.refreshToken) {
        const { error } = await supabase.auth.setSession({ access_token: hash.accessToken, refresh_token: hash.refreshToken })
        if (error) return finish({ state: "error", error: recoveryError(error.code ?? null, error.message) })
      }
      const { data } = await supabase.auth.getUser()
      finish(data.user ? { state: "ready", email: data.user.email ?? null } : { state: "error", error: "no_session" })
    })()
    return () => {
      alive = false
    }
  }, [params])

  if (status.state === "checking") return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Проверяем ссылку…</p>
  if (status.state === "error") {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">{RECOVERY_MESSAGES[status.error]}</p>
        <Link href="/forgot-password" className="text-sm text-primary hover:underline">Запросить новую ссылку →</Link>
      </div>
    )
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      {status.email && <p className="text-sm text-muted-foreground">Аккаунт: <span className="text-foreground">{status.email}</span></p>}
      <Field label="Новый пароль (не меньше 12 символов)" htmlFor="password">
        <span className="flex items-center gap-1.5">
          <Input id="password" name="password" type={show ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={200} required autoFocus className="flex-1" />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Скрыть" : "Показать"} className="rounded p-1.5 text-muted-foreground hover:text-primary">{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
        </span>
      </Field>
      <Field label="Повторите пароль" htmlFor="confirm">
        <Input id="confirm" name="confirm" type={show ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={200} required />
      </Field>
      <Button type="submit" size="lg" disabled={pending} className="w-full">{pending ? "Сохраняем…" : "Сохранить новый пароль"}</Button>
      <FormMessage state={state} />
    </form>
  )
}
