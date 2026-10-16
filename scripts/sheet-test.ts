/**
 * End-to-end test of the financial sheet workflow through the real data layer (src/lib/data/sheet.ts),
 * against a throwaway in-memory Postgres (PGlite) with every migration applied. Never connects to
 * Supabase. Fixtures are fictional. Usage: npm run test:sheet
 */
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { PrismaPg } from "@prisma/adapter-pg"

const PORT = 54329
process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${PORT}/postgres`
process.env.WALLET_ENCRYPTION_KEY = randomBytes(32).toString("base64")

let passed = 0
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok    ${name}`)
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`)
    process.exitCode = 1
  }
}
async function rejects(fn: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(fn, (error: Error) => {
    assert.match(error.message, pattern)
    return true
  })
}

async function main() {
  const pg = new PGlite()
  await pg.exec(`CREATE ROLE anon NOLOGIN NOINHERIT; CREATE ROLE authenticated NOLOGIN NOINHERIT;`)
  const dir = path.resolve("prisma/migrations")
  for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) {
    await pg.exec(readFileSync(path.join(dir, m, "migration.sql"), "utf8"))
  }
  const server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" })
  await server.start()

  const { PrismaClient } = await import("../src/generated/prisma/client")
  const sheet = await import("../src/lib/data/sheet")
  const { PERMISSIONS } = await import("../src/lib/authz/permissions")
  const { Decimal } = await import("../src/lib/money")
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 1 }) })

  try {
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
    const viewer = { ...admin, id: randomUUID(), permissions: new Set(["payroll:read", "salary:read"] as const) }
    const sep = { year: 2026, month: 9 }
    const oct = { year: 2026, month: 10 }
    const infl = await prisma.department.findFirstOrThrow({ where: { code: "INFLULORDS" } })
    const bizdev = await prisma.department.findFirstOrThrow({ where: { code: "BIZDEV" } })
    let employeeId = ""
    const row = async (m = sep) => (await sheet.getSheet(admin, m, prisma)).rows.find((r) => r.employeeId === employeeId)!

    console.log("financial sheet workflow")
    await step("add employee from the sheet (FIX 1,200, InfluLords)", async () => {
      const e = await sheet.addSheetEmployee(admin, sep, { name: "Test Employee", departmentId: infl.id, fix: "1200", currency: "USD", hireDate: null }, prisma)
      employeeId = e.id
      const r = await row()
      assert.equal(r.fix, "1200")
      assert.equal(r.departmentName, "InfluLords")
      assert.equal(r.calculated, "1200")
    })

    await step("terms 10% above KPI, KPI 3,000, fact 4,000 -> payable 1,300", async () => {
      await sheet.setCompensationRule(admin, sep, employeeId, { model: "PCT_ABOVE_KPI", ratePct: "10" }, prisma)
      await sheet.updateSheetCell(admin, sep, employeeId, "kpiTarget", "3000", prisma)
      await sheet.updateSheetCell(admin, sep, employeeId, "kpiActual", "$4,000", prisma)
      const r = await row()
      assert.equal(r.terms, "10% от профита после KPI")
      assert.equal(r.variable, "100")
      assert.equal(r.calculated, "1300")
    })

    await step("bonus 150 and deduction 50 -> 1,400", async () => {
      await sheet.updateSheetCell(admin, sep, employeeId, "bonus", "150", prisma)
      await sheet.updateSheetCell(admin, sep, employeeId, "deduction", "50", prisma)
      assert.equal((await row()).calculated, "1400")
    })

    await step("confirm snapshots the payslip; a later KPI change un-confirms it", async () => {
      await sheet.setRowConfirmed(admin, sep, employeeId, true, prisma)
      let r = await row()
      assert.equal(r.confirmed, true)
      assert.equal(r.approved, "1400")
      const { unconfirmed } = await sheet.updateSheetCell(admin, sep, employeeId, "kpiActual", "5000", prisma)
      assert.equal(unconfirmed, true)
      r = await row()
      assert.equal(r.confirmed, false)
      assert.equal(r.calculated, "1500")
    })

    await step("users without permission cannot edit or confirm", async () => {
      await rejects(() => sheet.updateSheetCell(viewer, sep, employeeId, "fix", "9999", prisma), /permission/)
      await rejects(() => sheet.setRowConfirmed(viewer, sep, employeeId, true, prisma), /permission/)
      await rejects(() => sheet.approveMonth(viewer, sep, null, prisma), /permission/)
    })

    await step("month cannot be approved with unconfirmed rows", async () => {
      await rejects(() => sheet.approveMonth(admin, sep, null, prisma), /not confirmed/)
    })

    await step("approve month posts a balanced payroll accrual to the ledger", async () => {
      await sheet.setRowConfirmed(admin, sep, employeeId, true, prisma)
      await sheet.approveMonth(admin, sep, "Looks right", prisma)
      const run = await prisma.payrollRun.findFirstOrThrow({ include: { journalEntry: { include: { lines: { include: { ledgerAccount: true } } } } } })
      assert.equal(run.status, "APPROVED")
      const lines = run.journalEntry!.lines
      const by = (code: string, side: "debit" | "credit") => lines.filter((l) => l.ledgerAccount.code === code).reduce((a, l) => a.add(new Decimal(l[side])), new Decimal(0)).toString()
      assert.equal(run.journalEntry!.status, "POSTED")
      assert.equal(by("5000", "debit"), "1550") // delivery payroll (InfluLords is cost of sales): 1,200 + 200 + 150
      assert.equal(by("5000", "credit"), "50") // deduction reduces the expense
      assert.equal(by("2100", "credit"), "1500") // net payable
      const adjustments = await prisma.payrollAdjustment.findMany({ where: { employeeId } })
      assert.ok(adjustments.every((a) => a.status === "APPLIED"))
    })

    await step("an approved month is locked", async () => {
      await rejects(() => sheet.updateSheetCell(admin, sep, employeeId, "fix", "2000", prisma), /approved/)
      await rejects(() => sheet.setRowConfirmed(admin, sep, employeeId, false, prisma), /approved/)
    })

    await step("salary change in October keeps September's history", async () => {
      await sheet.updateSheetCell(admin, oct, employeeId, "fix", "1500", prisma)
      assert.equal((await row(oct)).fix, "1500")
      assert.equal((await row(sep)).fix, "1200")
      assert.equal((await row(sep)).approved, "1500")
      const salaries = await prisma.salaryCondition.findMany({ where: { employeeId }, orderBy: { validFrom: "asc" } })
      assert.deepEqual(salaries.map((s) => [s.baseAmount.toString(), s.validTo?.toISOString().slice(0, 10) ?? null]), [["1200", "2026-10-01"], ["1500", null]])
    })

    await step("terms carry into October; changing them there starts a new version", async () => {
      assert.equal((await row(oct)).terms, "10% от профита после KPI")
      await sheet.setCompensationRule(admin, oct, employeeId, { model: "PCT_OF_PROFIT", ratePct: "7", capAmount: "500" }, prisma)
      assert.equal((await row(oct)).terms, "7% от профита, макс. $500")
      assert.equal((await row(sep)).terms, "10% от профита после KPI")
    })

    await step("department move from October keeps September in InfluLords", async () => {
      await sheet.updateSheetCell(admin, oct, employeeId, "department", bizdev.id, prisma)
      assert.equal((await row(oct)).departmentName, "Business Development")
      assert.equal((await row(sep)).departmentName, "InfluLords")
    })

    await step("wallet is stored encrypted and masked", async () => {
      const address = "TRvCuZ4fbLRNxsVTY5cN8EqrrwFJ9nFKx3"
      await sheet.updateSheetCell(admin, sep, employeeId, "wallet", address, prisma).catch(() => null) // September is approved
      await sheet.updateSheetCell(admin, oct, employeeId, "wallet", address, prisma)
      const wallet = await prisma.payoutWallet.findFirstOrThrow({ where: { employeeId } })
      assert.equal(wallet.maskedIdentifier, "TRvCuZ…nFKx3".replace("nFKx3", "FKx3"))
      assert.equal(wallet.network, "TRC20")
      assert.ok(!Buffer.from(wallet.detailsEncrypted!).toString("utf8").includes(address))
      assert.equal(await sheet.revealWallet(admin, wallet.id, prisma), address)
      const logs = await prisma.auditLog.findMany({ where: { action: "sheet.update.wallet" } })
      assert.ok(logs.every((l) => !JSON.stringify(l.after).includes(address)))
    })

    await step("partial then full payment, with ledger entries and run status", async () => {
      const cash = await prisma.ledgerAccount.create({
        data: { organizationId: org.id, code: "1010", name: "Main USDT wallet", type: "ASSET", subtype: "CASH", normalBalance: "DEBIT", cashFlowActivity: "NONE" },
      })
      const account = await prisma.financialAccount.create({ data: { organizationId: org.id, ledgerAccountId: cash.id, type: "CRYPTO_WALLET", name: "Main USDT wallet", currency: "USDT" } })
      const pay = (amount: string) =>
        sheet.recordPayment(admin, sep, { employeeId, amount: new Decimal(amount), currency: "USDT", fxRate: new Decimal(1), fee: new Decimal("1"), financialAccountId: account.id, paidAt: new Date("2026-10-05T00:00:00Z"), reference: null }, prisma)
      await pay("1000")
      let r = await row()
      assert.equal(r.paid, "1000")
      assert.equal(r.outstanding, "500")
      assert.equal(r.paymentStatus, "PARTIAL")
      await rejects(() => pay("600"), /larger than the outstanding/)
      await pay("500")
      r = await row()
      assert.equal(r.paymentStatus, "PAID")
      assert.equal(r.paymentDate, "2026-10-05")
      const run = await prisma.payrollRun.findFirstOrThrow()
      assert.equal(run.status, "PAID")
      const balance = await prisma.$queryRaw<{ v: string }[]>`
        SELECT (sum(l.debit) - sum(l.credit))::text v FROM journal_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id WHERE a.code = '2100'`
      assert.equal(new Decimal(balance[0].v).toString(), "0") // payroll payable fully settled
    })

    await step("the whole ledger balances", async () => {
      const [t] = await prisma.$queryRaw<{ d: string; c: string }[]>`SELECT sum(debit)::text d, sum(credit)::text c FROM journal_lines`
      assert.equal(new Decimal(t.d).toString(), new Decimal(t.c).toString())
    })

    await step("archived employees leave the sheet but keep history", async () => {
      await sheet.setEmployeeArchived(admin, employeeId, true, prisma)
      assert.equal((await sheet.getSheet(admin, { year: 2026, month: 11 }, prisma)).rows.length, 0)
      assert.equal((await sheet.getSheet(admin, sep, prisma)).rows.length, 1) // still on the approved month
      const history = await sheet.compensationHistory(admin, employeeId, prisma)
      assert.equal(history.salaries.length, 2)
      assert.equal(history.payslips[0].status, "PAID")
    })
  } finally {
    await prisma.$disconnect()
    await server.stop()
    await pg.close()
  }
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ", 0 failed"}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
