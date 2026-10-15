import "server-only"

import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "@/generated/prisma/client"
import { supabasePoolConfig } from "@/lib/db-ssl"

/**
 * Prisma client for server code, connected through the Supabase transaction pooler
 * (DATABASE_URL, port 6543) via the node-postgres driver adapter, with TLS verified
 * against the Supabase root CA.
 * Reused across hot reloads in development to avoid exhausting pooler connections.
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error("Missing DATABASE_URL. Set it in .env.local (see .env.example).")
  }

  return new PrismaClient({ adapter: new PrismaPg(supabasePoolConfig(connectionString)) })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
