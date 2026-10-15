/**
 * Read-only connectivity check: runs `SELECT 1` through Prisma and the pooled DATABASE_URL.
 * Never prints the connection string; errors are redacted before logging.
 * Usage: npm run db:check
 */
import { config } from "dotenv"
import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "../src/generated/prisma/client"
import { supabasePoolConfig } from "../src/lib/db-ssl"

config({ path: ".env.local", quiet: true })

const connectionString = process.env.DATABASE_URL

function redact(message: string) {
  let out = message.replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://[redacted]")
  if (connectionString) out = out.split(connectionString).join("[redacted]")
  return out
}

async function main() {
  if (!connectionString) {
    console.error("DATABASE_URL is not set in .env.local")
    process.exit(1)
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(supabasePoolConfig(connectionString)) })
  const started = Date.now()

  try {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`
    console.log(`Connected. SELECT 1 returned ${rows[0]?.ok} in ${Date.now() - started}ms.`)
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string }
    console.error(`Connection failed (${err.name ?? "Error"}${err.code ? `, code ${err.code}` : ""}):`)
    console.error(redact(err.message ?? String(error)))
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main()
