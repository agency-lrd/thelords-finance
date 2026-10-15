/**
 * Public Supabase settings. Names match .env.example.
 * Read lazily so builds succeed without credentials; clients throw on first use if unset.
 * Server-only connection strings (DATABASE_URL, DIRECT_URL) are reserved for a future
 * data/migrations layer and are intentionally not read here.
 */
export function getSupabaseEnv() {
  // Literal property access so Next.js can inline NEXT_PUBLIC_* values into the browser bundle.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (!url || !publishableKey) {
    throw new Error(
      "Missing Supabase configuration. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local (see .env.example)."
    )
  }

  return { url, publishableKey }
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
}
