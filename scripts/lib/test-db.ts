/**
 * Throwaway Postgres for integration tests: PGlite in memory with every migration applied, served over
 * the Postgres wire protocol so the real Prisma client and data layer run against it. Never touches
 * Supabase; fixtures are fictional.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { PrismaPg } from "@prisma/adapter-pg"

export async function startTestDb(port: number) {
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres`
  process.env.WALLET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64")
  const pg = new PGlite()
  await pg.exec(`CREATE ROLE anon NOLOGIN NOINHERIT; CREATE ROLE authenticated NOLOGIN NOINHERIT;`)
  const dir = path.resolve("prisma/migrations")
  for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) {
    await pg.exec(readFileSync(path.join(dir, m, "migration.sql"), "utf8"))
  }
  const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" })
  await server.start()

  const { PrismaClient } = await import("../../src/generated/prisma/client")
  const { PERMISSIONS } = await import("../../src/lib/authz/permissions")
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })
  const org = await prisma.organization.findFirstOrThrow()
  const adminId = randomUUID()
  await prisma.appUser.create({ data: { id: adminId, email: "admin@example.test", status: "ACTIVE", isSuperAdmin: true } })
  const admin = {
    id: adminId,
    email: "admin@example.test",
    displayName: null,
    isSuperAdmin: true,
    organizationId: org.id,
    organizationName: org.name,
    baseCurrency: "USD",
    permissions: new Set(PERMISSIONS),
  }
  return {
    prisma,
    org,
    admin,
    async stop() {
      await prisma.$disconnect()
      await server.stop()
      await pg.close()
    },
  }
}

export function stepRunner() {
  let passed = 0
  let failed = 0
  return {
    async step(name: string, fn: () => Promise<void>) {
      try {
        await fn()
        passed++
        console.log(`  ok    ${name}`)
      } catch (error) {
        failed++
        console.log(`  FAIL  ${name}\n        ${(error as Error).message}`)
        process.exitCode = 1
      }
    },
    summary() {
      console.log(`\n${passed} passed, ${failed} failed`)
    },
  }
}
