import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

const PUBLIC_PATHS = ["/login", "/onboarding", "/auth/", "/api/health"]

/**
 * Refreshes the Supabase session cookie and sends signed-out visitors to /login.
 * This is an optimistic check only: every page and Server Action re-verifies the user and
 * their permissions on the server (src/lib/auth/session.ts).
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path))

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    return isPublic ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url))
  }

  let response = NextResponse.next({ request })
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
        for (const [header, value] of Object.entries(headers)) response.headers.set(header, value)
      },
    },
  })

  const { data } = await supabase.auth.getClaims()
  if (!data?.claims && !isPublic) {
    const login = new URL("/login", request.url)
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`)
    const redirect = NextResponse.redirect(login)
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie)
    return redirect
  }
  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
}
