import "server-only"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

import type { Database } from "@/types/database"
import { getSupabaseEnv } from "./env"

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Create a new client per request. With Cache Components enabled, call this
 * inside a <Suspense> boundary because it reads request cookies.
 */
export async function createClient() {
  const { url, publishableKey } = getSupabaseEnv()
  const cookieStore = await cookies()

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore once a proxy refreshes sessions.
        }
      },
    },
  })
}
