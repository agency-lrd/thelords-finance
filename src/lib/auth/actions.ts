"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { RECOVERY_MESSAGES, RESET_PATH, recoveryError, siteOrigin } from "@/lib/auth/recovery"
import { isBootstrapEmail, onboardingOpen } from "@/lib/auth/session"
import type { ActionState } from "@/lib/forms"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"

/** Only same-site relative paths are accepted as post-login destinations. */
function safeNext(value: FormDataEntryValue | null) {
  const next = typeof value === "string" ? value : ""
  return next.startsWith("/") && !next.startsWith("//") ? next : "/"
}

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSupabaseConfigured()) {
    return { status: "error", message: "Sign-in is not configured yet (Supabase publishable key missing)." }
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase()
  const password = String(formData.get("password") ?? "")
  if (!email || !password) return { status: "error", message: "Enter your email and password." }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  // One generic message: never reveal whether the account exists.
  if (error) return { status: "error", message: "Invalid email or password." }

  redirect(safeNext(formData.get("next")))
}

export async function signOut() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient()
    await supabase.auth.signOut()
  }
  redirect("/login")
}

/**
 * First Super Admin sign-up. Only the SUPER_ADMIN_EMAIL address, only while no Super Admin exists.
 * Supabase sends a confirmation email; access is granted on the first sign-in after confirming.
 */
export async function signUpSuperAdmin(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSupabaseConfigured()) return { status: "error", message: "Sign-in is not configured yet (Supabase publishable key missing)." }
  const email = String(formData.get("email") ?? "").trim().toLowerCase()
  const password = String(formData.get("password") ?? "")
  // Same response for a wrong email as for a closed onboarding: never reveal the allowed address.
  if (!isBootstrapEmail(email) || !(await onboardingOpen())) {
    return { status: "error", message: "Onboarding is not available for this email." }
  }
  if (password.length < 12) return { status: "error", message: "Use a password of at least 12 characters." }

  const host = (await headers()).get("host")
  const protocol = host?.startsWith("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https"
  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: host ? `${protocol}://${host}/auth/callback` : undefined },
  })
  if (error) return { status: "error", message: error.message }
  return { status: "success", message: "Check your inbox to confirm the email, then sign in." }
}

/**
 * "Забыли пароль?": sends the Supabase recovery email. The link returns to /auth/callback on this
 * domain, which opens the "set a new password" page. The answer is the same whether or not the account
 * exists (no account enumeration); the email address is never logged.
 */
export async function requestPasswordReset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSupabaseConfigured()) return { status: "error", message: "Вход ещё не настроен." }
  const email = String(formData.get("email") ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { status: "error", message: "Введите корректный email." }
  const h = await headers()
  const origin = siteOrigin(h.get("x-forwarded-host") ?? h.get("host"), h.get("x-forwarded-proto"))
  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(RESET_PATH)}` })
  if (error && recoveryError(error.code, error.message) === "rate_limit") return { status: "error", message: RECOVERY_MESSAGES.rate_limit }
  return { status: "success", message: "Если такой аккаунт существует, мы отправили письмо со ссылкой для восстановления пароля. Ссылка действует ограниченное время и только один раз; откройте её в этом же браузере." }
}

/** Saves the new password for the account of the current recovery session (supabase.auth.updateUser). */
export async function updatePassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSupabaseConfigured()) return { status: "error", message: "Вход ещё не настроен." }
  const password = String(formData.get("password") ?? "")
  const confirm = String(formData.get("confirm") ?? "")
  if (password.length < 12) return { status: "error", message: RECOVERY_MESSAGES.too_short }
  if (password.length > 200) return { status: "error", message: RECOVERY_MESSAGES.weak_password }
  if (password !== confirm) return { status: "error", message: RECOVERY_MESSAGES.mismatch }
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return { status: "error", message: RECOVERY_MESSAGES.no_session }
  const { error } = await supabase.auth.updateUser({ password })
  if (error) return { status: "error", message: RECOVERY_MESSAGES[recoveryError(error.code, error.message)] }
  // Other devices that were signed in with the old password are signed out; this one stays signed in.
  await supabase.auth.signOut({ scope: "others" }).catch(() => undefined)
  redirect("/?password=updated")
}
