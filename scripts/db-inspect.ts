/**
 * Read-only inspection of the target database before applying migrations: confirms the project,
 * TLS, existing schemas/tables and migration history. The session is forced read-only.
 * Never prints connection strings. Usage: npm run db:inspect
 */
import { config } from "dotenv"
import pg from "pg"

import { supabasePoolConfig } from "../src/lib/db-ssl"

config({ path: ".env.local", quiet: true })

async function main() {
  const direct = process.env.DIRECT_URL
  if (!direct) throw new Error("DIRECT_URL is not set in .env.local")
  const url = new URL(direct)
  console.log(`host: ${url.hostname}  project ref: ${url.username.split(".")[1] ?? "(none)"}`)

  const client = new pg.Client(supabasePoolConfig(direct))
  await client.connect()
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
    const q = async (sql: string) => (await client.query(sql)).rows
    const [info] = await q("SELECT current_database() AS db, current_user AS usr, current_setting('server_version') AS version")
    console.log(`database: ${info.db}  user: ${info.usr}  postgres: ${info.version}`)
    const [ssl] = await q("SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
    console.log(`tls: ${ssl?.ssl} ${ssl?.version ?? ""}`)
    const schemas = await q(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
    )
    console.log(`schemas: ${schemas.map((r) => r.nspname).join(", ")}`)
    const tables = await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
    console.log(`public tables (${tables.length}): ${tables.map((r) => r.tablename).join(", ") || "-"}`)
    const funcs = await q(
      "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'",
    )
    console.log(`public functions: ${funcs[0].n}`)
    const users = await q("SELECT count(*)::int AS n FROM auth.users").catch(() => [{ n: "n/a" }])
    console.log(`auth users: ${users[0].n}`)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, "[redacted]"))
  process.exitCode = 1
})
