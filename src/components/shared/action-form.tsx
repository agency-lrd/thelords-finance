"use client"

import { useActionState, useEffect, useRef, type ReactNode } from "react"
import { useFormStatus } from "react-dom"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { idleState, type ActionState } from "@/lib/forms"

type Props = {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>
  submitLabel: string
  children?: ReactNode
  className?: string
  /** Clear inputs after a successful submit (default true). */
  resetOnSuccess?: boolean
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary"
  size?: "default" | "sm" | "xs"
  confirm?: string
}

/** Form bound to a Server Action, with pending state and the server's success/error message. */
export function ActionForm({ action, submitLabel, children, className, resetOnSuccess = true, variant, size, confirm }: Props) {
  const [state, formAction] = useActionState(action, idleState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state.status === "success" && resetOnSuccess) formRef.current?.reset()
  }, [state, resetOnSuccess])

  return (
    <form
      ref={formRef}
      action={formAction}
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label={submitLabel} variant={variant} size={size} />
        <FormMessage state={state} />
      </div>
    </form>
  )
}

function SubmitButton({ label, variant, size }: { label: string; variant?: Props["variant"]; size?: Props["size"] }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} variant={variant} size={size}>
      {pending ? "Saving…" : label}
    </Button>
  )
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.status === "idle" || !state.message) return null
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={cn("text-xs", state.status === "error" ? "text-destructive" : "text-primary")}
    >
      {state.message}
    </p>
  )
}
