/**
 * Credential register access rules end to end, on a throwaway PGlite database (never Supabase).
 * Usage: npm run test:vault
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54331)
  const { step, summary } = stepRunner()
  const vault = await import("../src/lib/data/vault")
  const { PERMISSIONS } = await import("../src/lib/authz/permissions")

  // Session-like users with permissions as the app computes them from their roles.
  const member = async (email: string, roleKey: string, scopeDepartmentId: string | null = null) => {
    const id = randomUUID()
    await prisma.appUser.create({ data: { id, email, status: "ACTIVE" } })
    const role = await prisma.role.findFirstOrThrow({ where: { organizationId: org.id, key: roleKey } })
    await prisma.userRoleAssignment.create({ data: { organizationId: org.id, userId: id, roleId: role.id, scopeDepartmentId } })
    const rows = await prisma.$queryRaw<{ key: string }[]>`SELECT "key" FROM "permissions" WHERE "finance_private"."user_has_permission"(${id}::uuid, ${org.id}::uuid, "key")`
    return { ...admin, id, email, isSuperAdmin: false, permissions: new Set(rows.map((r) => r.key).filter((k): k is (typeof PERMISSIONS)[number] => (PERMISSIONS as readonly string[]).includes(k))) }
  }
  const infl = await prisma.department.findFirstOrThrow({ where: { code: "INFLULORDS" } })
  const owner = await member("owner@example.test", "OWNER")
  const cfo = await member("cfo@example.test", "CFO")
  const head = await member("head@example.test", "DEPARTMENT_HEAD", infl.id)
  const employee = await member("employee@example.test", "EMPLOYEE")
  const category = (await vault.listVaultCategories(admin, prisma))[0]
  const input = (name: string, extra: Partial<Parameters<typeof vault.createCredential>[1]> = {}) => ({
    name, loginUrl: "https://ads.example.test", username: "ads@thelords.test", departmentId: infl.id, categoryId: category.id, responsibleEmployeeId: null,
    accessLevel: "STANDARD" as const, vaultProvider: "BITWARDEN" as const, vaultItemRef: "https://vault.bitwarden.com/#/vault?itemId=abc", notes: "2FA on the team lead's phone", ...extra,
  })

  try {
    console.log("credential register")
    let adsId = ""
    let bankId = ""
    await step("Owner adds entries; secrets in notes, usernames or URLs are refused", async () => {
      adsId = (await vault.createCredential(owner, input("Ads cabinet"), prisma)).id
      bankId = (await vault.createCredential(owner, input("Bank portal", { accessLevel: "CRITICAL" }), prisma)).id
      await assert.rejects(() => vault.createCredential(owner, input("X", { notes: "Пароль: Qwerty123!" }), prisma), /secret \(password\)/)
      await assert.rejects(() => vault.createCredential(owner, input("X", { loginUrl: "https://me:pw@site.test" }), prisma), /secret/)
      await assert.rejects(() => vault.createCredential(owner, input("X", { notes: "abandon ability able about above absent absorb abstract absurd abuse access accident" }), prisma), /seed phrase/)
    })

    await step("Super Admin and Owner see every entry", async () => {
      assert.equal((await vault.listCredentials(admin, {}, prisma)).length, 2)
      assert.equal((await vault.listCredentials(owner, {}, prisma)).length, 2)
    })

    await step("CFO, department head and employee see nothing until shared; department never grants access", async () => {
      assert.equal((await vault.listCredentials(cfo, {}, prisma)).length, 0)
      assert.equal((await vault.listCredentials(head, {}, prisma)).length, 0) // head of InfluLords, entries are in InfluLords
      assert.equal((await vault.listCredentials(employee, {}, prisma)).length, 0)
      await assert.rejects(() => vault.recordAccess(employee, adsId, "view", prisma), /not shared/)
    })

    await step("explicit share: the employee sees exactly the shared entry, view only", async () => {
      await vault.shareCredential(owner, adsId, employee.id, "VIEW", prisma)
      const list = await vault.listCredentials(employee, {}, prisma)
      assert.deepEqual(list.map((c) => c.name), ["Ads cabinet"])
      assert.equal(list[0].canEdit, false)
      assert.equal(list[0].sharedWith, null) // non-managers do not see who else has access
      await assert.rejects(() => vault.updateCredential(employee, adsId, input("Renamed"), prisma), /not edit/)
      await assert.rejects(() => vault.shareCredential(employee, adsId, head.id, "VIEW", prisma), /Only vault managers/)
      await assert.rejects(() => vault.createCredential(employee, input("Mine"), prisma), /Only vault managers/)
    })

    await step("edit share lets the user change the entry; every action is in the history", async () => {
      await vault.shareCredential(owner, adsId, employee.id, "EDIT", prisma)
      await vault.updateCredential(employee, adsId, input("Ads cabinet (main)"), prisma)
      await vault.recordAccess(employee, adsId, "copy_username", prisma)
      await vault.recordAccess(employee, adsId, "open_login", prisma)
      const history = await vault.credentialHistory(owner, adsId, prisma)
      assert.deepEqual(history.map((h) => h.action).reverse(), ["create", "share", "share", "update", "copy_username", "open_login"])
      assert.ok(history.every((h) => !JSON.stringify(h.details ?? "").includes("ads@thelords.test")), "usernames never written to the audit log")
      await assert.rejects(() => vault.credentialHistory(employee, adsId, prisma), /permission/)
    })

    await step("unshare removes access immediately and keeps the grant as history", async () => {
      const shares = await vault.listShares(owner, adsId, prisma)
      assert.equal(shares.length, 1)
      await vault.unshareCredential(owner, shares[0].id, prisma)
      assert.equal((await vault.listCredentials(employee, {}, prisma)).length, 0)
      assert.equal(await prisma.vaultCredentialGrant.count({ where: { credentialId: adsId } }), 2)
    })

    await step("archive hides entries from the default list; filters and search work", async () => {
      await vault.setArchived(owner, bankId, true, prisma)
      assert.equal((await vault.listCredentials(owner, {}, prisma)).length, 1)
      assert.equal((await vault.listCredentials(owner, { archived: true }, prisma)).length, 1)
      assert.equal((await vault.listCredentials(owner, { search: "main" }, prisma)).length, 1)
      assert.equal((await vault.listCredentials(owner, { accessLevel: "CRITICAL" }, prisma)).length, 0)
    })

    await step("custom categories", async () => {
      await vault.createVaultCategory(owner, "Платёжные шлюзы", prisma)
      assert.equal((await vault.listVaultCategories(owner, prisma)).length, 11)
      await assert.rejects(() => vault.createVaultCategory(employee, "x", prisma), /Only vault managers/)
    })

    await step("no column anywhere can hold a password", async () => {
      const cols = await prisma.$queryRaw<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_name LIKE 'vault_%' AND column_name ~* '(pass|secret|token|seed|private)'`
      assert.deepEqual(cols, [])
    })
  } finally {
    await stop()
  }
  summary()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
