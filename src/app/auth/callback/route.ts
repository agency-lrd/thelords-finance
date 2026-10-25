import { NextResponse, type NextRequest } from "next/server"

import { RESET_PATH, recoveryError, safeNext } from "@/lib/auth/recovery"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"

/**
 * Landing for every email link (confirmation, magic link, password recovery). Supports the three link
 * formats Supabase can send:
 *   ?code=…                       PKCE (link requested from this site; same browser)
 *   ?token_hash=…&type=recovery   token hash (works on any device)
 *   #access_token=…               implicit flow: the fragment never reaches the server, so the browser is
 *                                 sent on to the reset page, which reads it there.
 * A recovery link always ends on the "set a new password" page. Tokens are never logged.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  if (!isSupabaseConfigured()) return NextResponse.redirect(new URL("/login", request.url))
  const type = searchParams.get("type")
  const next = safeNext(searchParams.get("next"), type === "recovery" ? RESET_PATH : "/")
  const recovery = type === "recovery" || next === RESET_PATH

  // Supabase sends errors back as ?error=…&error_code=… (for example an expired link).
  const linkError = searchParams.get("error_code") ?? searchParams.get("error")
  if (linkError) return NextResponse.redirect(new URL(`${recovery ? RESET_PATH : "/login"}?error=${recoveryError(linkError, searchParams.get("error_description"))}`, request.url))

  const code = searchParams.get("code")
  const tokenHash = searchParams.get("token_hash")
  if (!code && !tokenHash) {
    // Implicit flow: tokens are in the fragment, which browsers keep across this redirect.
    return NextResponse.redirect(new URL(recovery ? RESET_PATH : "/login", request.url))
  }
  const supabase = await createClient()
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : type === "signup" || type === "email" || type === "magiclink" || type === "recovery" || type === "invite"
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash!, type })
      : { error: { code: "invalid", message: "unsupported link type" } }
  if (error) return NextResponse.redirect(new URL(`${recovery ? RESET_PATH : "/login"}?error=${recoveryError(error.code ?? null, error.message)}`, request.url))
  return NextResponse.redirect(new URL(next, request.url))
}
