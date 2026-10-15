import path from "node:path"

import { config } from "dotenv"
import { defineConfig } from "prisma/config"

// Prisma 7 does not load env files itself; mirror Next.js and read .env.local.
config({ path: ".env.local", quiet: true })

const SUPABASE_CA_FILE = path.resolve("prisma/certs/supabase-root-2021-ca.crt")

/**
 * CLI connection URL (migrate, introspect, db execute).
 *
 * Normally run through `npm run db:prisma -- <command>`, which starts a loopback relay that
 * verifies Supabase's certificate with Node TLS and passes its URL in PRISMA_TLS_RELAY_URL.
 * The relay exists because macOS's TLS stack (used by the schema engine there) rejects
 * Supabase's pooler certificate even with the correct CA.
 *
 * Without the relay, DIRECT_URL (session pooler, port 5432) is used with strict verification
 * against the pinned CA. Prisma's default `sslmode=require` does NOT verify certificates.
 */
function cliDatasourceUrl() {
  const relayUrl = process.env.PRISMA_TLS_RELAY_URL
  if (relayUrl) {
    // The relay URL carries sslmode=disable, so only ever accept it on loopback.
    if (new URL(relayUrl).hostname !== "127.0.0.1") {
      throw new Error("PRISMA_TLS_RELAY_URL must point at the loopback relay (127.0.0.1)")
    }
    return relayUrl
  }
  if (!process.env.DIRECT_URL) return ""

  const url = new URL(process.env.DIRECT_URL)
  url.searchParams.set("sslmode", "require")
  url.searchParams.set("sslaccept", "strict")
  url.searchParams.set("sslcert", SUPABASE_CA_FILE)
  return url.toString()
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: cliDatasourceUrl(),
  },
})
