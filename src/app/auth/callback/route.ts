import { NextResponse, type NextRequest } from "next/server"

import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"

/** Email confirmation / magic-link landing: exchanges the code for a session, then opens the app. */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  if (!isSupabaseConfigured()) return NextResponse.redirect(new URL("/login", request.url))
  const supabase = await createClient()
  const code = searchParams.get("code")
  const tokenHash = searchParams.get("token_hash")
  const type = searchParams.get("type")
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && (type === "signup" || type === "email" || type === "magiclink" || type === "recovery")
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("missing code") }
  return NextResponse.redirect(new URL(error ? "/login?error=confirm" : "/", request.url))
}
