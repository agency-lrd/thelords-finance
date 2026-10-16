/**
 * Grants platform Super Admin to an existing Supabase Auth account and gives it the Owner role in
 * THE LORDS GROUP. Super Admin can only be granted here (never from the web UI).
 *
 * The account must exist first: Supabase Dashboard > Authentication > Users > Add user.
 * Usage: npm run admin:grant-super -- --email you@example.com --yes
 * Idempotent; writes an audit log entry. Prints no secrets.
 */
import { config } from "dotenv"
import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "../src/generated/prisma/client"
import { supabasePoolConfig } from "../src/lib/db-ssl"

config({ path: ".env.local", quiet: true })

const ORGANIZATION_NAME = "THE LORDS GROUP"

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const email = arg("email")?.trim().toLowerCase()
  if (!email || !email.includes("@")) throw new Error("Pass --email <address of an existing Supabase Auth user>")
  if (!process.argv.includes("--yes")) throw new Error("This grants full access. Re-run with --yes to confirm.")
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set in .env.local")

  const prisma = new PrismaClient({ adapter: new PrismaPg(supabasePoolConfig(process.env.DATABASE_URL)) })
  try {
    await prisma.$transaction(async (tx) => {
      const [authUser] = await tx.$queryRaw<{ id: string; email: string }[]>`
        SELECT id, lower(email) AS email FROM auth.users WHERE lower(email) = ${email} AND deleted_at IS NULL`
      if (!authUser) throw new Error("No Supabase Auth user with that email. Create it in the Supabase Dashboard first.")

      const organization = await tx.organization.findFirst({ where: { name: ORGANIZATION_NAME } })
      if (!organization) throw new Error(`Organization ${ORGANIZATION_NAME} not found`)
      const owner = await tx.role.findUniqueOrThrow({
        where: { organizationId_key: { organizationId: organization.id, key: "OWNER" } },
      })

      await tx.appUser.upsert({
        where: { id: authUser.id },
        create: { id: authUser.id, email: authUser.email, status: "ACTIVE", isSuperAdmin: true },
        update: { status: "ACTIVE", isSuperAdmin: true },
      })
      const hasOwner = await tx.userRoleAssignment.findFirst({
        where: { userId: authUser.id, roleId: owner.id, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
      })
      if (!hasOwner) {
        await tx.userRoleAssignment.create({ data: { organizationId: organization.id, userId: authUser.id, roleId: owner.id } })
      }
      await tx.auditLog.create({
        data: {
          organizationId: organization.id,
          actorType: "SYSTEM",
          action: "access.grant_super_admin",
          entityType: "app_user",
          entityId: authUser.id,
          after: { via: "scripts/grant-super-admin.ts", ownerRole: true },
        },
      })
    })
    console.log("Super Admin granted (with Owner role in THE LORDS GROUP).")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: Error) => {
  console.error(error.message.replace(/postgres(ql)?:\/\/\S+/g, "[redacted]"))
  process.exit(1)
})
