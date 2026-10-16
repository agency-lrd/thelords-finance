"use server"

import { redirect } from "next/navigation"

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
