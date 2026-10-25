/**
 * Credential register access rules end to end, on a throwaway PGlite database (never Supabase).
 * Usage: npm run test:vault
 */
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"

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

    console.log("stored passwords")
    const secrets = await import("../src/lib/data/vault-secrets")
    const crypto = await import("../src/lib/vault/secrets")
    const PASSWORD = "Sup3r-Secret-Value!42"
    await step("without a vault key the feature is off (no plaintext fallback)", async () => {
      delete process.env.VAULT_ENCRYPTION_KEYS
      assert.equal(crypto.vaultConfigured(), false)
      await assert.rejects(() => secrets.setVaultSecret(admin, adsId, PASSWORD, prisma), /not configured/)
      process.env.VAULT_ENCRYPTION_KEYS = `k1:${randomBytes(32).toString("base64")}`
      assert.equal(crypto.vaultConfigured(), true)
    })
    await step("only the Super Admin stores passwords; the database holds ciphertext only", async () => {
      await assert.rejects(() => secrets.setVaultSecret(owner, adsId, PASSWORD, prisma), /Super Admin/)
      await secrets.setVaultSecret(admin, adsId, PASSWORD, prisma)
      const row = await prisma.vaultSecret.findUniqueOrThrow({ where: { credentialId: adsId } })
      assert.equal(row.keyId, "k1")
      assert.ok(!Buffer.from(row.ciphertext).toString("utf8").includes(PASSWORD) && !Buffer.from(row.ciphertext).toString("base64").includes(Buffer.from(PASSWORD).toString("base64")))
      // List queries never carry the secret.
      const listed = JSON.stringify(await vault.listCredentials(admin, {}, prisma))
      assert.ok(!listed.includes(PASSWORD) && !listed.includes("ciphertext"))
    })
    await step("viewing needs a fresh password check; values never reach the audit log", async () => {
      await assert.rejects(() => secrets.revealVaultSecret(admin, adsId, { unlocked: false, purpose: "view" }, prisma), /FRESH_AUTH_REQUIRED/)
      await assert.rejects(() => secrets.revealVaultSecret(owner, adsId, { unlocked: true, purpose: "view" }, prisma), /Super Admin/)
      assert.equal(await secrets.revealVaultSecret(admin, adsId, { unlocked: true, purpose: "view" }, prisma), PASSWORD)
      assert.equal(await secrets.revealVaultSecret(admin, adsId, { unlocked: true, purpose: "copy" }, prisma), PASSWORD)
      const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: "vault.secret" } } })
      assert.deepEqual(logs.map((l) => l.action).sort(), ["vault.secret.copy", "vault.secret.reveal", "vault.secret.set"])
      assert.ok(!JSON.stringify(logs, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(PASSWORD))
      // Unlock tokens: bound to the user and short-lived.
      const token = crypto.issueUnlockToken(admin.id)
      assert.equal(crypto.verifyUnlockToken(token, admin.id), true)
      assert.equal(crypto.verifyUnlockToken(token, owner.id), false)
      assert.equal(crypto.verifyUnlockToken(token, admin.id, Date.now() + 11 * 60_000), false)
      assert.equal(crypto.verifyUnlockToken(`${token}x`, admin.id), false)
    })
    await step("a ciphertext moved to another entry does not decrypt (bound to its record)", async () => {
      const row = await prisma.vaultSecret.findUniqueOrThrow({ where: { credentialId: adsId } })
      assert.throws(() => crypto.decryptVaultSecret(row.ciphertext, row.keyId, crypto.secretAad(org.id, bankId)))
    })
    let otherId = ""
    await step("key rotation re-encrypts with the new key without losing anything", async () => {
      otherId = (await vault.createCredential(owner, input("Exchange account"), prisma)).id
      await secrets.setVaultSecret(admin, otherId, "bank-π-пароль", prisma)
      process.env.VAULT_ENCRYPTION_KEYS = `k2:${randomBytes(32).toString("base64")},${process.env.VAULT_ENCRYPTION_KEYS}`
      assert.deepEqual(await secrets.rotateVaultKeys(admin, prisma), { rotated: 2, activeKeyId: "k2" })
      process.env.VAULT_ENCRYPTION_KEYS = process.env.VAULT_ENCRYPTION_KEYS.split(",")[0]
      assert.equal(await secrets.revealVaultSecret(admin, otherId, { unlocked: true, purpose: "view" }, prisma), "bank-π-пароль")
      assert.equal(await secrets.revealVaultSecret(admin, adsId, { unlocked: true, purpose: "view" }, prisma), PASSWORD)
    })
    await step("deleting a stored password is audited; database roles have no access to the table", async () => {
      await secrets.deleteVaultSecret(admin, otherId, prisma)
      assert.equal(await prisma.vaultSecret.count({ where: { credentialId: otherId } }), 0)
      assert.equal(await prisma.auditLog.count({ where: { action: "vault.secret.delete", entityId: otherId } }), 1)
      const [grants] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_name = 'vault_secrets' AND grantee IN ('anon', 'authenticated')`)
      assert.equal(grants.n, 0)
    })

    await step("new entry form: save the entry and its password in one step; encrypted, never in lists or the audit log", async () => {
      const SYNTHETIC = "Synthetic-Only-Pass#2026"
      const form = { name: "Test platform", loginUrl: "https://test.example.test", username: "qa@example.test", departmentId: infl.id, categoryId: category.id, accessLevel: "STANDARD" as const, notes: null }
      // Without the Super Admin a password is refused and nothing is created.
      const before = await prisma.vaultCredential.count()
      await assert.rejects(() => secrets.saveCredentialWithPassword(owner, null, form, SYNTHETIC, prisma), /Super Admin/)
      assert.equal(await prisma.vaultCredential.count(), before, "no half-saved entry")
      const id = await secrets.saveCredentialWithPassword(admin, null, form, SYNTHETIC, prisma)
      const row = await prisma.vaultSecret.findUniqueOrThrow({ where: { credentialId: id } })
      assert.ok(!Buffer.from(row.ciphertext).toString("utf8").includes(SYNTHETIC))
      assert.equal(await secrets.revealVaultSecret(admin, id, { unlocked: true, purpose: "view" }, prisma), SYNTHETIC)
      assert.equal(await secrets.revealVaultSecret(admin, id, { unlocked: true, purpose: "copy" }, prisma), SYNTHETIC)
      // Editing without a password keeps the stored one; with a new one replaces it.
      await secrets.saveCredentialWithPassword(admin, id, { ...form, name: "Test platform 2" }, null, prisma)
      assert.equal(await secrets.revealVaultSecret(admin, id, { unlocked: true, purpose: "view" }, prisma), SYNTHETIC)
      await secrets.saveCredentialWithPassword(admin, id, form, "Synthetic-New-Pass#2027", prisma)
      assert.equal(await secrets.revealVaultSecret(admin, id, { unlocked: true, purpose: "view" }, prisma), "Synthetic-New-Pass#2027")
      const listed = JSON.stringify(await vault.listCredentials(admin, {}, prisma))
      const logs = JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: id } }), (_k, v) => (typeof v === "bigint" ? v.toString() : v))
      for (const text of [listed, logs]) assert.ok(!text.includes(SYNTHETIC) && !text.includes("Synthetic-New-Pass"))
      await secrets.deleteVaultSecret(admin, id, prisma)
      assert.equal(await prisma.vaultSecret.count({ where: { credentialId: id } }), 0)
    })
    await step("removed form fields keep their stored values (responsible, password manager, item link)", async () => {
      const legacy = await prisma.vaultCredential.findUniqueOrThrow({ where: { id: adsId } })
      assert.equal(legacy.vaultProvider, "BITWARDEN")
      await secrets.saveCredentialWithPassword(admin, adsId, { name: legacy.name, loginUrl: legacy.loginUrl, username: legacy.username, departmentId: legacy.departmentId, categoryId: legacy.categoryId, accessLevel: legacy.accessLevel, notes: legacy.notes }, null, prisma)
      const after = await prisma.vaultCredential.findUniqueOrThrow({ where: { id: adsId } })
      assert.deepEqual([after.vaultProvider, after.vaultItemRef, after.responsibleEmployeeId], [legacy.vaultProvider, legacy.vaultItemRef, legacy.responsibleEmployeeId])
      assert.equal(await secrets.revealVaultSecret(admin, adsId, { unlocked: true, purpose: "view" }, prisma), PASSWORD, "the existing encrypted password is untouched")
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
