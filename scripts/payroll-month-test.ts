/**
 * Payroll confirmation, monthly approval and strict month-to-month rollover end to end on a throwaway
 * PGlite database (never Supabase). Employees move forward one month at a time, from the immediately
 * previous approved month; approved months are frozen snapshots. All data is fictional.
 * Usage: npm run test:payroll-month
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54336)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const reports = await import("../src/lib/reports/ledger")
  const { range } = await import("../src/lib/reports/periods")

  const jan = { year: 2026, month: 1 }
  const feb = { year: 2026, month: 2 }
  const mar = { year: 2026, month: 3 }
  const apr = { year: 2026, month: 4 }
  const dept = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  const other = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "BIZDEV" } })
  const ids: Record<string, string> = {}
  const rows = async (m: typeof jan, user = admin) => (await sheet.getSheet(user, m, prisma)).rows
  const row = async (m: typeof jan, name: string) => (await rows(m)).find((r) => r.employeeId === ids[name])
  const add = async (name: string, fix: string, hireDate: string, m = jan) =>
    (ids[name] = (await sheet.addSheetEmployee(admin, m, { name, departmentId: dept.id, fix, currency: "USD", hireDate: new Date(`${hireDate}T00:00:00Z`) }, prisma)).id)
  const confirm = (name: string, m = jan, on = true, user = admin) => sheet.setRowConfirmed(user, m, ids[name], on, prisma)
  const confirmAll = async (m: typeof jan) => {
    for (const r of await rows(m)) await sheet.setRowConfirmed(admin, m, r.employeeId, true, prisma)
  }
  const carry = (m: typeof jan, names: string[], edits: Record<string, { fix?: string; departmentId?: string }> = {}) =>
    sheet.carryForwardEmployees(admin, m, names.map((n) => ({ employeeId: ids[n], ...edits[n] })), prisma)
  const ledger = async () => JSON.stringify(await prisma.journalEntry.findMany({ orderBy: { entryNumber: "asc" }, include: { lines: { orderBy: { id: "asc" } } } }))

  try {
    await step("setup: Alexander (Influence, from 07.01.2026, FIX 1,000), Boris and Clara in January", async () => {
      await add("Alexander", "1000", "2026-01-07")
      await add("Boris", "2000", "2026-01-01")
      await add("Clara", "1500", "2026-01-15")
      assert.equal((await rows(jan)).length, 3)
    })

    await step("confirm and unconfirm employees independently; confirmation is not payment", async () => {
      await confirm("Alexander")
      assert.deepEqual([(await row(jan, "Alexander"))!.confirmed, (await row(jan, "Alexander"))!.paid], [true, "0"])
      await confirm("Alexander", jan, false)
      assert.equal((await row(jan, "Alexander"))!.confirmed, false)
      await confirm("Boris")
      await confirm("Clara")
      assert.deepEqual((await rows(jan)).map((r) => [r.name, r.confirmed]).sort(), [["Alexander", false], ["Boris", true], ["Clara", true]])
      assert.equal(await prisma.journalEntry.count(), 0)
    })

    await step("a confirmed salary edit needs reconfirmation only if the result changes", async () => {
      assert.equal((await sheet.updateSheetCell(admin, jan, ids.Boris, "kpiTarget", "5000", prisma, "")).unconfirmed, false)
      assert.equal((await sheet.updateSheetCell(admin, jan, ids.Boris, "fix", "2100", prisma, "2000", "month")).unconfirmed, true)
      await confirm("Boris")
    })

    await step("9. rollover from an unapproved month is refused with a clear reason", async () => {
      await assert.rejects(() => carry(feb, ["Alexander"]), /January 2026 is not approved yet/)
      const preview = await sheet.carryForwardPreview(admin, feb, prisma)
      assert.equal(preview.previousApproved, false)
      assert.equal((await rows(feb)).length, 0, "February is empty until January is approved and carried over")
    })

    await step("approval is refused with a list of what is missing, and needs payroll:approve", async () => {
      const preview = await sheet.approvalPreview(admin, jan, prisma)
      assert.deepEqual(preview.issues.map((i) => [i.name, i.reason]), [["Alexander", "unconfirmed"]])
      await assert.rejects(() => sheet.approveMonth(admin, jan, null, prisma), /not confirmed/)
      await confirm("Alexander")
      const preparer = { ...admin, isSuperAdmin: false, permissions: new Set([...admin.permissions].filter((p) => p !== "payroll:approve")) as typeof admin.permissions }
      await assert.rejects(() => sheet.approveMonth(preparer, jan, null, prisma), /permission/)
    })

    let janLedger = ""
    let janSnapshot = ""
    await step("1. approve January: snapshot frozen, posted once, approver recorded, period stays open, nothing paid", async () => {
      await sheet.approveMonth(admin, jan, "January checked", prisma)
      const run = await prisma.payrollRun.findFirstOrThrow({ where: { period: { year: 2026, month: 1 } }, include: { approvals: true, period: true } })
      assert.deepEqual([run.status, run.approvals[0].approverId, run.period.status], ["APPROVED", admin.id, "OPEN"])
      const members = await prisma.payrollMonthEmployee.findMany({ where: { periodId: run.periodId } })
      assert.ok(members.every((m) => m.snapshot !== null && m.snapshotAt))
      assert.ok((await rows(jan)).every((r) => r.paid === "0" && r.outstanding === r.approved))
      const pnl = (await reports.pnlReport(admin, range("month", 2026, 1), {}, prisma)).current
      // Prorated from the start date (30-day convention): Alexander 1,000 × 24/30 = 800 (from the 7th),
      // Boris 2,100 (full month), Clara 1,500 × 16/30 = 800 (from the 15th).
      assert.equal(Number(pnl.costOfServices) + Number(pnl.operatingExpenses), 3700)
      janLedger = await ledger()
      janSnapshot = JSON.stringify(await rows(jan))
    })

    await step("2. copy January employees into February (preview, then selected employees)", async () => {
      const preview = await sheet.carryForwardPreview(admin, feb, prisma)
      assert.equal(preview.previousApproved, true)
      assert.deepEqual(preview.employees.map((e) => [e.name, e.fix, e.present]).sort(), [["Alexander", "1000", false], ["Boris", "2100", false], ["Clara", "1500", false]])
      // Boris's January-only raise is what January approved; it carries as his February FIX.
      assert.deepEqual(await carry(feb, ["Alexander", "Boris"]), { added: 2, skipped: 0 })
      assert.deepEqual((await rows(feb)).map((r) => r.name).sort(), ["Alexander", "Boris"], "only the selected employees")
      const f = (await row(feb, "Alexander"))!
      assert.deepEqual([f.fix, f.departmentId, f.confirmed, f.bonus, f.kpiActual, f.paid, f.monthSource], ["1000", dept.id, false, "0", null, "0", "CARRIED"])
      assert.equal(await prisma.employee.count({ where: { organizationId: org.id } }), 3, "no duplicate employee profiles")
    })

    await step("10. duplicate rollover is skipped, never overwrites the month", async () => {
      await sheet.updateSheetCell(admin, feb, ids.Boris, "notes", "edited in February", prisma)
      assert.deepEqual(await carry(feb, ["Boris", "Clara"], { Boris: { fix: "9999" } }), { added: 1, skipped: 1 })
      const b = (await row(feb, "Boris"))!
      assert.deepEqual([b.fix, b.notes], ["2100", "edited in February"])
      assert.equal(await prisma.payrollMonthEmployee.count({ where: { period: { year: 2026, month: 2 } } }), 3)
    })

    await step("3-4. change February FIX 1,000 → 1,300 and department: January stays exactly as approved", async () => {
      await sheet.updateSheetCell(admin, feb, ids.Alexander, "fix", "1300", prisma, "1000")
      await sheet.updateSheetCell(admin, feb, ids.Alexander, "department", other.id, prisma, dept.id)
      await sheet.updateSheetCell(admin, feb, ids.Alexander, "name", "Alexander Petrov", prisma, "Alexander")
      const f = (await row(feb, "Alexander"))!
      assert.deepEqual([f.fix, f.departmentId, f.name], ["1300", other.id, "Alexander Petrov"])
      const j = (await row(jan, "Alexander"))!
      assert.deepEqual([j.fix, j.approved, j.departmentId, j.name], ["1000", "800", dept.id, "Alexander"], "January shows its snapshot, not today's profile")
      assert.equal(JSON.stringify(await rows(jan)), janSnapshot)
    })

    await step("5. approve February", async () => {
      await confirmAll(feb)
      await sheet.approveMonth(admin, feb, null, prisma)
      assert.equal((await prisma.payrollRun.findFirstOrThrow({ where: { period: { year: 2026, month: 2 } } })).status, "APPROVED")
    })

    await step("6-8. copy February into March: March starts with FIX 1,300; start date unchanged", async () => {
      assert.deepEqual(await carry(mar, ["Alexander", "Boris", "Clara"]), { added: 3, skipped: 0 })
      const m = (await row(mar, "Alexander"))!
      assert.deepEqual([m.fix, m.departmentId, m.hireDate, m.name], ["1300", other.id, "2026-01-07", "Alexander Petrov"])
      assert.equal((await row(jan, "Alexander"))!.hireDate, "2026-01-07")
      assert.equal((await prisma.employee.findUniqueOrThrow({ where: { id: ids.Alexander } })).hireDate.toISOString().slice(0, 10), "2026-01-07")
    })

    await step("months are independent: editing March never changes February or January", async () => {
      const febBefore = JSON.stringify(await rows(feb))
      await sheet.updateSheetCell(admin, mar, ids.Alexander, "fix", "1500", prisma, "1300")
      assert.equal((await row(mar, "Alexander"))!.fix, "1500")
      assert.equal(JSON.stringify(await rows(feb)), febBefore)
      assert.equal(JSON.stringify(await rows(jan)), janSnapshot)
    })

    await step("employees move only from the immediately previous month (April needs March approved)", async () => {
      await assert.rejects(() => carry(apr, ["Alexander"]), /March 2026 is not approved yet/)
      const preview = await sheet.carryForwardPreview(admin, apr, prisma)
      assert.equal(preview.previous, "2026-03")
    })

    await step("recurring KPI targets carry; KPI results, bonuses and confirmations do not", async () => {
      await sheet.updateSheetCell(admin, mar, ids.Boris, "kpiTarget", "8000", prisma, "", "future")
      await sheet.updateSheetCell(admin, mar, ids.Boris, "kpiActual", "9000", prisma, "")
      await sheet.updateSheetCell(admin, mar, ids.Boris, "bonus", "200", prisma)
      await confirmAll(mar)
      await sheet.approveMonth(admin, mar, null, prisma)
      await carry(apr, ["Boris"])
      const b = (await row(apr, "Boris"))!
      assert.deepEqual([b.kpiTarget, b.kpiActual, b.bonus, b.confirmed], ["8000", null, "0", false])
    })

    await step("termination: someone who left is not carried into later months", async () => {
      await sheet.updateSheetCell(admin, apr, ids.Boris, "status", "TERMINATED", prisma)
      await confirmAll(apr)
      await sheet.approveMonth(admin, apr, null, prisma)
      const may = { year: 2026, month: 5 }
      const preview = await sheet.carryForwardPreview(admin, may, prisma)
      assert.equal(preview.employees.find((e) => e.employeeId === ids.Boris)!.terminated, true)
      assert.deepEqual(await carry(may, ["Boris"]), { added: 0, skipped: 1 })
    })

    await step("11. earlier approvals, snapshots and accounting entries are unchanged", async () => {
      const janEntries = JSON.parse(janLedger) as { id: string }[]
      const now = JSON.parse(await ledger()) as { id: string }[]
      assert.deepEqual(now.slice(0, janEntries.length), janEntries, "January's journal entries are untouched")
      assert.equal(await prisma.journalEntry.count({ where: { source: "PAYROLL" } }), 4, "one payroll accrual per approved month")
      assert.equal(JSON.stringify(await rows(jan)), janSnapshot)
      const janRun = await prisma.payrollRun.findFirstOrThrow({ where: { period: { year: 2026, month: 1 } }, include: { approvals: true } })
      assert.deepEqual([janRun.status, janRun.approvals.length], ["APPROVED", 1])
      await assert.rejects(() => sheet.approveMonth(admin, jan, null, prisma), /approved/)
      await assert.rejects(() => sheet.updateSheetCell(admin, jan, ids.Alexander, "fix", "5000", prisma), /approved/)
    })

    await step("the approved snapshot is immutable in the database", async () => {
      const member = await prisma.payrollMonthEmployee.findFirstOrThrow({ where: { period: { year: 2026, month: 1 } } })
      await prisma.$executeRawUnsafe(`CREATE TEMP TABLE IF NOT EXISTS rule_result (message text); TRUNCATE rule_result;`)
      await prisma.$executeRawUnsafe(`DO $$ BEGIN BEGIN UPDATE payroll_month_employees SET snapshot = '{}' WHERE id = '${member.id}'; INSERT INTO rule_result VALUES ('accepted'); EXCEPTION WHEN OTHERS THEN INSERT INTO rule_result VALUES (SQLERRM); END; END $$;`)
      const [r] = await prisma.$queryRawUnsafe<{ message: string }[]>(`SELECT message FROM rule_result`)
      assert.match(r.message, /immutable/)
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
