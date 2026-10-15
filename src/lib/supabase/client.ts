import { createBrowserClient } from "@supabase/ssr"

import type { Database } from "@/types/database"
import { getSupabaseEnv } from "./env"

/** Supabase client for Client Components. */
export function createClient() {
  const { url, publishableKey } = getSupabaseEnv()
  return createBrowserClient<Database>(url, publishableKey)
}
