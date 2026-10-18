/**
 * Payroll confirmation, monthly approval and month-to-month rollover end to end on a throwaway PGlite
 * database (never Supabase). Covers the 17 scenarios of the payroll brief. All data is fictional.
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
  const dept = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  const ids: Record<string, string> = {}
  const rows = async (m: typeof jan, user = admin) => (await sheet.getSheet(user, m, prisma)).rows
  const row = async (m: typeof jan, name: string) => (await rows(m)).find((r) => r.employeeId === ids[name])
  const add = async (name: string, fix: string, hireDate: string, m = jan) =>
    (ids[name] = (await sheet.addSheetEmployee(admin, m, { name, departmentId: dept.id, fix, currency: "USD", hireDate: new Date(`${hireDate}T00:00:00Z`) }, prisma)).id)
  const confirm = (name: string, m = jan, on = true, user = admin) => sheet.setRowConfirmed(user, m, ids[name], on, prisma)
  const items = (m: typeof jan) => prisma.payrollItem.count({ where: { payrollRun: { period: { year: m.year, month: m.month } } } })

  try {
    await step("setup: Alexander (from 07.01.2026, FIX 1,000), Boris and Clara in January", async () => {
      await add("Alexander", "1000", "2026-01-07")
      await add("Boris", "2000", "2026-01-01")
      await add("Clara", "1500", "2026-01-15")
      assert.equal((await rows(jan)).length, 3)
    })

    await step("1. confirm an employee's payroll (calculation accepted; nothing posted, nothing paid)", async () => {
      await confirm("Alexander")
      const r = (await row(jan, "Alexander"))!
      assert.deepEqual([r.confirmed, r.approved, r.paid], [true, "1000", "0"])
      assert.equal(await prisma.journalEntry.count(), 0)
    })

    await step("2. unconfirm, and confirm several employees independently", async () => {
      await confirm("Alexander", jan, false)
      assert.equal((await row(jan, "Alexander"))!.confirmed, false)
      assert.equal(await prisma.auditLog.count({ where: { action: "payroll_item.unconfirm" } }), 1)
      await confirm("Boris")
      await confirm("Clara")
      assert.deepEqual((await rows(jan)).map((r) => [r.name, r.confirmed]).sort(), [["Alexander", false], ["Boris", true], ["Clara", true]])
    })

    await step("3. editing a confirmed salary requires reconfirmation only when the result changes", async () => {
      const changed = await sheet.updateSheetCell(admin, jan, ids.Boris, "fix", "2100", prisma, "2000", "month")
      assert.equal(changed.unconfirmed, true)
      assert.equal((await row(jan, "Boris"))!.confirmed, false)
      await confirm("Boris")
      // A KPI target without commission terms does not change the result: the confirmation stays.
      const same = await sheet.updateSheetCell(admin, jan, ids.Boris, "kpiTarget", "5000", prisma, "")
      assert.equal(same.unconfirmed, false)
      assert.equal((await row(jan, "Boris"))!.confirmed, true)
    })

    await step("5. approval is refused with a clear list while confirmations are missing", async () => {
      const preview = await sheet.approvalPreview(admin, jan, prisma)
      assert.equal(preview.canApprove, false)
      assert.deepEqual(preview.issues.map((i) => [i.name, i.reason]), [["Alexander", "unconfirmed"]])
      await assert.rejects(() => sheet.approveMonth(admin, jan, null, prisma), /not confirmed/)
    })

    await step("17. an unauthorized user cannot approve payroll", async () => {
      await confirm("Alexander")
      const preparer = { ...admin, isSuperAdmin: false, permissions: new Set([...admin.permissions].filter((p) => p !== "payroll:approve")) as typeof admin.permissions }
      assert.equal((await sheet.approvalPreview(preparer, jan, prisma)).canApprove, false)
      await assert.rejects(() => sheet.approveMonth(preparer, jan, null, prisma), /permission/)
    })

    let janTotal = 0
    await step("4. approve a fully confirmed month: approver and time recorded, period stays open", async () => {
      const preview = await sheet.approvalPreview(admin, jan, prisma)
      assert.equal(preview.canApprove, true)
      assert.deepEqual(preview.totals, [{ currency: "USD", amount: "4600" }]) // 1,000 + 2,100 + 1,500
      janTotal = 4600
      await sheet.approveMonth(admin, jan, "January checked", prisma)
      const run = await prisma.payrollRun.findFirstOrThrow({ where: { period: { year: 2026, month: 1 } }, include: { approvals: true, period: true } })
      assert.equal(run.status, "APPROVED")
      assert.equal(run.approvals[0].approverId, admin.id)
      assert.ok(run.approvals[0].decidedAt instanceof Date)
      assert.equal(run.period.status, "OPEN", "approving payroll does not close the accounting period")
      const after = await sheet.approvalPreview(admin, jan, prisma)
      assert.equal(after.approvedBy, admin.email)
    })

    await step("15. approval is not payment: nothing paid, the full amount outstanding and owed", async () => {
      const r = await rows(jan)
      assert.ok(r.every((x) => x.paid === "0" && x.outstanding === x.approved && x.paymentStatus === "UNPAID"))
      assert.equal(await prisma.payrollPayment.count(), 0)
    })

    await step("16. P&L recognizes payroll exactly once, even if approval is tried again", async () => {
      const pnl = async () => (await reports.pnlReport(admin, range("month", 2026, 1), {}, prisma)).current
      const before = await pnl()
      assert.equal(Number(before.costOfServices) + Number(before.operatingExpenses), janTotal)
      await assert.rejects(() => sheet.approveMonth(admin, jan, null, prisma), /approved/)
      assert.equal(await prisma.journalEntry.count({ where: { source: "PAYROLL" } }), 1)
      assert.deepEqual(await pnl(), before)
    })

    await step("6-8. February shows every active employee with the same identity and start date", async () => {
      await add("Dmitri", "900", "2026-02-10", feb)
      const f = await rows(feb)
      assert.deepEqual(f.map((r) => r.name).sort(), ["Alexander", "Boris", "Clara", "Dmitri"])
      assert.equal((await rows(jan)).some((r) => r.name === "Dmitri"), false, "a new hire does not appear before the start month")
      assert.equal((await row(feb, "Alexander"))!.hireDate, "2026-01-07")
      assert.equal(await prisma.employee.count({ where: { organizationId: org.id } }), 4, "no duplicate profiles")
      const b = (await row(feb, "Boris"))!
      assert.equal(b.fix, "2000", "Boris's January-only raise did not carry into February")
      assert.deepEqual([b.confirmed, b.bonus, b.kpiActual, b.paid], [false, "0", null, "0"], "confirmation, bonuses, KPI results and payments are not copied")
    })

    await step("13. opening months creates nothing; confirming twice keeps one payslip", async () => {
      const runs = await prisma.payrollRun.count()
      await rows(mar)
      await rows(mar)
      assert.equal(await prisma.payrollRun.count(), runs)
      await confirm("Clara", feb)
      await confirm("Clara", feb)
      assert.equal(await items(feb), 1)
    })

    await step("9-11. February raise for Alexander; January unchanged; March inherits it", async () => {
      await sheet.updateSheetCell(admin, feb, ids.Alexander, "fix", "1300", prisma, "1000", "future")
      assert.equal((await row(feb, "Alexander"))!.fix, "1300")
      const j = (await row(jan, "Alexander"))!
      assert.deepEqual([j.fix, j.approved], ["1000", "1000"], "January keeps its salary and approved amount")
      assert.equal((await row(mar, "Alexander"))!.fix, "1300")
      assert.equal((await row(mar, "Alexander"))!.hireDate, "2026-01-07")
      // A "this month only" change does not carry on.
      await sheet.updateSheetCell(admin, feb, ids.Clara, "fix", "1800", prisma, "1500", "month")
      assert.deepEqual([(await row(feb, "Clara"))!.fix, (await row(mar, "Clara"))!.fix], ["1800", "1500"])
    })

    await step("recurring KPI targets carry forward; month-only targets and KPI results do not", async () => {
      await sheet.updateSheetCell(admin, feb, ids.Alexander, "kpiTarget", "10000", prisma, "", "future")
      await sheet.updateSheetCell(admin, feb, ids.Alexander, "kpiActual", "12000", prisma, "")
      await sheet.updateSheetCell(admin, feb, ids.Dmitri, "kpiTarget", "3000", prisma, "", "month")
      const a = (await row(mar, "Alexander"))!
      assert.deepEqual([a.kpiTarget, a.kpiTargetInherited, a.kpiActual], ["10000", true, null])
      assert.equal((await row(mar, "Dmitri"))!.kpiTarget, null)
    })

    await step("14. termination: no future months, unless something is still to settle", async () => {
      await sheet.updateSheetCell(admin, feb, ids.Dmitri, "status", "TERMINATED", prisma)
      assert.ok(await row(feb, "Dmitri"), "still on the sheet in the month they leave")
      assert.equal(await row(mar, "Dmitri"), undefined)
      await sheet.updateSheetCell(admin, mar, ids.Dmitri, "deduction", "50", prisma)
      assert.ok(await row(mar, "Dmitri"), "visible again while a March adjustment exists")
    })

    await step("12. manual carry-forward: brings back a missing employee, updates a present one, never duplicates", async () => {
      await sheet.updateSheetCell(admin, feb, ids.Clara, "status", "TERMINATED", prisma)
      assert.equal(await row(mar, "Clara"), undefined)
      const preview = await sheet.carryForwardPreview(admin, mar, prisma)
      assert.deepEqual(preview.employees.filter((e) => !e.present).map((e) => e.name).sort(), ["Clara"])
      const result = await sheet.carryForwardEmployees(admin, mar, [{ employeeId: ids.Clara }, { employeeId: ids.Boris, fix: "2500" }], prisma)
      assert.deepEqual(result, { added: 1, updated: 1 })
      const c = (await row(mar, "Clara"))!
      assert.deepEqual([c.hireDate, c.fix], ["2026-01-15", "1500"], "start date unchanged; February's one-month raise not carried")
      assert.equal((await row(mar, "Boris"))!.fix, "2500")
      assert.equal((await row(feb, "Boris"))!.fix, "2000")
      const again = await sheet.carryForwardEmployees(admin, mar, [{ employeeId: ids.Clara }], prisma)
      assert.deepEqual(again, { added: 0, updated: 1 })
      assert.equal(await prisma.employee.count({ where: { organizationId: org.id } }), 4)
      const overlaps = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM salary_conditions a JOIN salary_conditions b ON a.employee_id = b.employee_id AND a.id < b.id
        WHERE a.valid_from < coalesce(b.valid_to, 'infinity') AND b.valid_from < coalesce(a.valid_to, 'infinity')`
      assert.equal(overlaps[0].n, 0, "no overlapping salary terms")
    })

    await step("approved history is protected: a later change cannot reach back into January", async () => {
      await assert.rejects(() => sheet.updateSheetCell(admin, jan, ids.Alexander, "fix", "5000", prisma), /approved/)
      await assert.rejects(() => sheet.setRowConfirmed(admin, jan, ids.Alexander, false, prisma), /approved/)
      assert.equal((await row(jan, "Alexander"))!.approved, "1000")
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
