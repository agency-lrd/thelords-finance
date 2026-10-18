/**
 * Financial sheet months and period status end to end on a throwaway PGlite database (never Supabase):
 * month-specific data, historical payroll preservation, review/closed restrictions, audited reopen
 * and monthly totals. All data is fictional. Usage: npm run test:period
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54335)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const periods = await import("../src/lib/data/periods")
  const { createFinancialAccount } = await import("../src/lib/data/accounts")
  const tx = await import("../src/lib/data/transactions")
  const { Decimal } = await import("../src/lib/money")

  const sep = { year: 2026, month: 9 }
  const oct = { year: 2026, month: 10 }
  const nextYear = { year: 2027, month: 10 }
  const dept = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  // A manager who edits the sheet but does not close periods.
  const editor = { ...admin, isSuperAdmin: false, permissions: new Set([...admin.permissions].filter((p) => !p.startsWith("period:"))) as typeof admin.permissions }
  let a = ""
  let b = ""
  const total = async (m: typeof sep, user = admin) => (await sheet.getSheet(user, m, prisma)).rows.reduce((s, r) => s.add(r.calculated), new Decimal(0)).toString()
  const rowOf = async (m: typeof sep, id: string, user = admin) => (await sheet.getSheet(user, m, prisma)).rows.find((r) => r.employeeId === id)!

  try {
    await step("setup: two employees from September", async () => {
      a = (await sheet.addSheetEmployee(admin, sep, { name: "Alpha One", departmentId: dept.id, fix: "1000", currency: "USD", hireDate: null }, prisma)).id
      b = (await sheet.addSheetEmployee(admin, sep, { name: "Beta Two", departmentId: dept.id, fix: "2000", currency: "USD", hireDate: null }, prisma)).id
    })

    await step("selecting another month shows that month's data; totals are per month", async () => {
      await sheet.updateSheetCell(admin, sep, a, "bonus", "300", prisma)
      await sheet.updateSheetCell(admin, oct, b, "fix", "2500", prisma, "2000")
      assert.equal(await total(sep), "3300") // 1,000 + 300 bonus + 2,000
      assert.equal(await total(oct), "3500") // 1,000 + 2,500 (the September bonus is not in October)
      assert.equal((await rowOf(sep, b)).fix, "2000", "a raise from October leaves September as it was")
    })

    await step("selecting another year: salary terms carry forward, month records do not", async () => {
      const r = await rowOf(nextYear, b)
      assert.equal(r.fix, "2500")
      assert.equal(r.bonus, "0")
      assert.equal(await total(nextYear), "3500")
    })

    await step("historical payroll is preserved: an approved month is fixed while later months change", async () => {
      await sheet.setRowConfirmed(admin, sep, a, true, prisma)
      await sheet.setRowConfirmed(admin, sep, b, true, prisma)
      await sheet.approveMonth(admin, sep, null, prisma)
      const before = JSON.stringify((await sheet.getSheet(admin, sep, prisma)).rows.map((r) => [r.employeeId, r.approved]))
      await sheet.updateSheetCell(admin, oct, a, "fix", "1200", prisma, "1000")
      assert.equal(JSON.stringify((await sheet.getSheet(admin, sep, prisma)).rows.map((r) => [r.employeeId, r.approved])), before)
      assert.equal((await sheet.getSheet(admin, sep, prisma)).editable, false)
      await assert.rejects(() => sheet.updateSheetCell(admin, sep, a, "fix", "5000", prisma), /approved/)
    })

    await step("period status: a new month is open; months are never closed automatically", async () => {
      const info = await periods.periodInfo(admin, oct, prisma)
      assert.equal(info.status, "OPEN")
      assert.equal((await periods.periodInfo(admin, { year: 2030, month: 1 }, prisma)).status, "OPEN")
    })

    await step("under review: only people who close periods can edit", async () => {
      await assert.rejects(() => periods.setPeriodStatus(editor, oct, "review", null, prisma), /period:close/)
      await periods.setPeriodStatus(admin, oct, "review", null, prisma)
      assert.equal((await periods.periodInfo(admin, oct, prisma)).status, "CLOSING")
      assert.equal((await sheet.getSheet(editor, oct, prisma)).editable, false)
      assert.equal((await sheet.getSheet(admin, oct, prisma)).editable, true)
      await assert.rejects(() => sheet.updateSheetCell(editor, oct, a, "notes", "x", prisma), /under review/)
      await sheet.updateSheetCell(admin, oct, a, "notes", "checked", prisma)
    })

    await step("closed: nobody edits the month; other screens refuse it too", async () => {
      await periods.setPeriodStatus(admin, oct, "close", null, prisma)
      const info = await periods.periodInfo(admin, oct, prisma)
      assert.equal(info.status, "CLOSED")
      assert.equal(info.closedBy, admin.email)
      assert.equal((await sheet.getSheet(admin, oct, prisma)).editable, false)
      await assert.rejects(() => sheet.updateSheetCell(admin, oct, a, "notes", "late", prisma), /closed/)
      const bank = await createFinancialAccount(admin, { name: "Bank", type: "BANK", currency: "USD", institution: null }, prisma)
      const category = await prisma.financialCategory.findFirstOrThrow({ where: { code: "SOFTWARE" } })
      await assert.rejects(
        () =>
          tx.createTransaction(
            admin,
            { type: "OPERATING_EXPENSE", date: new Date("2026-10-10T00:00:00Z"), description: "Late", amount: new Decimal(10), currency: "USD", fxRate: null, fee: null, financialAccountId: bank.id, counterFinancialAccountId: null, categoryId: category.id, debitAccountId: null, creditAccountId: null, departmentId: null, clientId: null, projectId: null, shareholderId: null, counterparty: null, direction: null, settlementStatus: "PAID", dueDate: null, notes: null, attachmentUrl: null },
            {},
            prisma,
          ),
        /closed/,
      )
      assert.equal(await total(oct), "3700", "the closed month still reads correctly")
    })

    await step("reopening needs period:reopen and a reason, and is audited", async () => {
      await assert.rejects(() => periods.setPeriodStatus(editor, oct, "reopen", "fix", prisma), /period:reopen/)
      await assert.rejects(() => periods.setPeriodStatus(admin, oct, "reopen", "", prisma), /reason/)
      await periods.setPeriodStatus(admin, oct, "reopen", "Late invoice found", prisma)
      assert.equal((await periods.periodInfo(admin, oct, prisma)).status, "OPEN")
      const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: "period." } }, orderBy: { id: "asc" } })
      assert.deepEqual(logs.map((l) => l.action), ["period.review", "period.close", "period.reopen"])
      assert.equal((logs[2].after as { reason: string }).reason, "Late invoice found")
      await sheet.updateSheetCell(editor, oct, a, "notes", "editable again", prisma)
    })

    await step("closing rules: draft transactions are not journal entries; an open month cannot be reopened", async () => {
      const bank = await prisma.financialAccount.findFirstOrThrow({ where: { organizationId: org.id } })
      const category = await prisma.financialCategory.findFirstOrThrow({ where: { code: "SOFTWARE" } })
      await tx.createTransaction(admin, { type: "OPERATING_EXPENSE", date: new Date("2026-11-03T00:00:00Z"), description: "Draft", amount: new Decimal(5), currency: "USD", fxRate: null, fee: null, financialAccountId: bank.id, counterFinancialAccountId: null, categoryId: category.id, debitAccountId: null, creditAccountId: null, departmentId: null, clientId: null, projectId: null, shareholderId: null, counterparty: null, direction: null, settlementStatus: "PAID", dueDate: null, notes: null, attachmentUrl: null }, {}, prisma)
      // Draft transactions have no journal entry yet, so closing is allowed; a draft journal entry would block it.
      const info = await periods.periodInfo(admin, { year: 2026, month: 11 }, prisma)
      assert.equal(info.draftEntries, 0)
      await assert.rejects(() => periods.setPeriodStatus(admin, { year: 2026, month: 11 }, "reopen", "why", prisma), /cannot go from OPEN/)
    })
  } finally {
    summary()
    await stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
