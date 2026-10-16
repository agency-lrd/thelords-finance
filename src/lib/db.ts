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

function client() {
  globalForPrisma.prisma ??= createPrismaClient()
  return globalForPrisma.prisma
}

/**
 * Created on first use, not at import: builds and public pages (login) work without database
 * credentials, and a missing DATABASE_URL fails only the request that needs the database.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const instance = client()
    const value = Reflect.get(instance, property, instance)
    return typeof value === "function" ? value.bind(instance) : value
  },
  has(_target, property) {
    return Reflect.has(client(), property)
  },
})
