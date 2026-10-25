/**
 * Financial sheet pay logic end to end on a throwaway PGlite database (never Supabase): manual KPI and
 * PROFIT, the automatic 10% KPI bonus, FACT PAYMENT overrides, confirmation, approval, audited
 * re-opening and re-approval, prorated FIX for mid-month hires and month-to-month rollover.
 * All data is fictional. Usage: npm run test:sheet-pay
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54337)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const reports = await import("../src/lib/reports/ledger")
  const { range } = await import("../src/lib/reports/periods")
  const { createFinancialAccount } = await import("../src/lib/data/accounts")
  const { Decimal } = await import("../src/lib/money")

  const oct = { year: 2026, month: 10 }
  const nov = { year: 2026, month: 11 }
  const dept = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  const ids: Record<string, string> = {}
  const row = async (m: typeof oct, name: string) => (await sheet.getSheet(admin, m, prisma)).rows.find((r) => r.employeeId === ids[name])!
  const edit = (m: typeof oct, name: string, field: Parameters<typeof sheet.updateSheetCell>[3], value: string, reason?: string) =>
    sheet.updateSheetCell(admin, m, ids[name], field, value, prisma, undefined, undefined, reason)
  const payrollCost = async (m: typeof oct) => {
    const pnl = (await reports.pnlReport(admin, range("month", m.year, m.month), {}, prisma)).current
    return Number(pnl.costOfServices) + Number(pnl.operatingExpenses)
  }

  try {
    await step("setup: Alexander (full month), Maria (starts on the 13th)", async () => {
      ids.Alexander = (await sheet.addSheetEmployee(admin, oct, { name: "Alexander", departmentId: dept.id, fix: "1000", currency: "USD", hireDate: new Date("2026-09-01T00:00:00Z") }, prisma)).id
      ids.Maria = (await sheet.addSheetEmployee(admin, oct, { name: "Maria", departmentId: dept.id, fix: "1000", currency: "USD", hireDate: new Date("2026-10-13T00:00:00Z") }, prisma)).id
      assert.equal((await row(oct, "Alexander")).commissionPct, "10", "new employees get the standard 10% above KPI")
    })

    await step("1-2. manual KPI 3,000 and PROFIT 4,000 → KPI bonus 10% of 1,000 = 100", async () => {
      await edit(oct, "Alexander", "kpiTarget", "3000")
      await edit(oct, "Alexander", "kpiActual", "4000")
      const r = await row(oct, "Alexander")
      assert.deepEqual([r.kpiTarget, r.kpiActual, r.variable, r.calculated], ["3000", "4000", "100", "1100"])
      // PROFIT is the employee's result, not company income: no transaction or journal entry is created.
      assert.equal(await prisma.transaction.count(), 0)
      assert.equal(await prisma.journalEntry.count(), 0)
      await edit(oct, "Alexander", "kpiActual", "2500")
      assert.equal((await row(oct, "Alexander")).variable, "0", "below KPI: no bonus")
      await edit(oct, "Alexander", "kpiActual", "-500")
      assert.equal((await row(oct, "Alexander")).kpiActual, "-500", "negative profit is allowed")
      await edit(oct, "Alexander", "kpiActual", "4000")
    })

    await step("commission % per employee: 15% → 150; manual bonus stays separate", async () => {
      await edit(oct, "Alexander", "commission", "15")
      await edit(oct, "Alexander", "bonus", "50")
      const r = await row(oct, "Alexander")
      assert.deepEqual([r.commissionPct, r.variable, r.bonus, r.calculated], ["15", "150", "50", "1200"])
      await edit(oct, "Alexander", "commission", "10")
      await edit(oct, "Alexander", "bonus", "")
      assert.equal((await row(oct, "Alexander")).calculated, "1100")
    })

    await step("11. prorated FIX: 1,000 from the 13th of October → 18/30 days = 600", async () => {
      const r = await row(oct, "Maria")
      assert.deepEqual([r.fix, r.fixProrated, r.proration?.days, r.calculated], ["1000", "600", 18, "600"])
      assert.equal(r.hireDate, "2026-10-13")
    })

    await step("3. FACT PAYMENT: 1,500 above the calculation; below needs a reason; reset returns to the calculation", async () => {
      await edit(oct, "Alexander", "fact", "1500")
      let r = await row(oct, "Alexander")
      assert.deepEqual([r.calculated, r.fact, r.payable], ["1100", "1500", "1500"])
      await assert.rejects(() => edit(oct, "Alexander", "fact", "900"), /reason/)
      await edit(oct, "Alexander", "fact", "900", "Advance paid in September")
      r = await row(oct, "Alexander")
      assert.deepEqual([r.payable, r.factReason], ["900", "Advance paid in September"])
      // Changing the calculation never overwrites a manual amount.
      await edit(oct, "Alexander", "kpiActual", "5000")
      r = await row(oct, "Alexander")
      assert.deepEqual([r.calculated, r.payable], ["1200", "900"])
      await edit(oct, "Alexander", "fact", "")
      r = await row(oct, "Alexander")
      assert.deepEqual([r.fact, r.payable], [null, "1200"])
      await edit(oct, "Alexander", "kpiActual", "4000")
      await edit(oct, "Alexander", "fact", "1300")
    })

    await step("4. confirm; changing FACT PAYMENT requires confirming again", async () => {
      await sheet.setRowConfirmed(admin, oct, ids.Alexander, true, prisma)
      assert.equal((await row(oct, "Alexander")).confirmed, true)
      await sheet.setRowConfirmed(admin, oct, ids.Alexander, false, prisma)
      assert.equal((await row(oct, "Alexander")).confirmed, false, "click again to un-confirm")
      await sheet.setRowConfirmed(admin, oct, ids.Alexander, true, prisma)
      const result = await edit(oct, "Alexander", "fact", "1400")
      assert.equal(result.unconfirmed, true)
      assert.equal((await row(oct, "Alexander")).confirmed, false)
      await edit(oct, "Alexander", "fact", "1300")
      await sheet.setRowConfirmed(admin, oct, ids.Alexander, true, prisma)
      await sheet.setRowConfirmed(admin, oct, ids.Maria, true, prisma)
    })

    await step("5. approve: totals show calculated vs FACT; the payslip and P&L use FACT PAYMENT", async () => {
      const preview = await sheet.approvalPreview(admin, oct, prisma)
      assert.deepEqual(preview.totals, [{ currency: "USD", amount: "1900" }])
      assert.deepEqual(preview.calculatedTotals, [{ currency: "USD", amount: "1700" }])
      assert.deepEqual(preview.corrections.map((c) => [c.name, c.calculated, c.payable]), [["Alexander", "1100", "1300"]])
      await sheet.approveMonth(admin, oct, null, prisma)
      const r = await row(oct, "Alexander")
      assert.deepEqual([r.approved, r.payable, r.calculated], ["1300", "1300", "1100"])
      const item = await prisma.payrollItem.findFirstOrThrow({ where: { employeeId: ids.Alexander }, include: { lines: true } })
      assert.ok(item.lines.some((l) => l.lineType === "ADJUSTMENT" && l.amount.toString() === "200" && l.description.startsWith("FACT PAYMENT")))
      assert.equal(await payrollCost(oct), 1900)
      assert.equal(await prisma.transaction.count(), 0, "approval is not a payment")
    })

    let approvedJournal = ""
    await step("6. re-open with an audit trail: reason required, history kept, accrual reversed", async () => {
      const run = await prisma.payrollRun.findFirstOrThrow({ where: { period: { year: 2026, month: 10 } } })
      approvedJournal = run.journalEntryId!
      const noReopen = { ...admin, isSuperAdmin: false, permissions: new Set([...admin.permissions].filter((p) => p !== "period:reopen")) as typeof admin.permissions }
      await assert.rejects(() => sheet.reopenMonth(noReopen, oct, "fix", prisma), /permission/)
      await assert.rejects(() => sheet.reopenMonth(admin, oct, "", prisma), /reason/)
      await sheet.reopenMonth(admin, oct, "Maria's bonus was missing", prisma)

      const after = await prisma.payrollRun.findFirstOrThrow({ where: { id: run.id }, include: { approvals: { orderBy: { step: "asc" } } } })
      assert.equal(after.status, "CALCULATED")
      assert.deepEqual(after.approvals.map((a) => a.decision), ["APPROVED", "CHANGES_REQUESTED"])
      const original = await prisma.journalEntry.findUniqueOrThrow({ where: { id: approvedJournal } })
      assert.equal(original.status, "REVERSED", "the original accrual stays, marked reversed")
      assert.equal(await prisma.journalEntry.count({ where: { reversesEntryId: approvedJournal } }), 1)
      assert.equal(await payrollCost(oct), 0, "accrual and reversal net to zero")
      const version = await prisma.payrollApprovalVersion.findFirstOrThrow({ where: { payrollRunId: run.id } })
      assert.deepEqual([version.version, version.reason, version.previousStatus], [1, "Maria's bonus was missing", "APPROVED"])
      assert.equal((version.content as { members: unknown[] }).members.length, 2)
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "payroll_run.reopen" } })
      assert.equal((log.after as { reason: string }).reason, "Maria's bonus was missing")
      assert.equal((await sheet.getSheet(admin, oct, prisma)).editable, true)
      assert.equal((await row(oct, "Alexander")).confirmed, true, "rows stay confirmed until something changes")
      // The version history is append-only.
      await prisma.$executeRawUnsafe(`CREATE TEMP TABLE IF NOT EXISTS rule_result (message text); TRUNCATE rule_result;`)
      await prisma.$executeRawUnsafe(`DO $$ BEGIN BEGIN DELETE FROM payroll_approval_versions; INSERT INTO rule_result VALUES ('accepted'); EXCEPTION WHEN OTHERS THEN INSERT INTO rule_result VALUES (SQLERRM); END; END $$;`)
      const [r] = await prisma.$queryRawUnsafe<{ message: string }[]>(`SELECT message FROM rule_result`)
      assert.match(r.message, /append-only/)
    })

    await step("7. correct and approve again: one active accrual with the corrected amount", async () => {
      await edit(oct, "Maria", "bonus", "100")
      assert.equal((await row(oct, "Maria")).confirmed, false)
      await sheet.setRowConfirmed(admin, oct, ids.Maria, true, prisma)
      await sheet.approveMonth(admin, oct, "Corrected", prisma)
      assert.equal(await payrollCost(oct), 2000)
      assert.equal(await prisma.journalEntry.count({ where: { source: "PAYROLL", status: "POSTED" } }), 1)
      const preview = await sheet.approvalPreview(admin, oct, prisma)
      assert.equal(preview.reopenings.length, 1)
      assert.equal(preview.approvedBy, admin.email)
      assert.equal((await row(oct, "Maria")).approved, "700")
    })

    await step("re-opening is refused once a salary payment is recorded", async () => {
      const bank = await createFinancialAccount(admin, { name: "Bank", type: "BANK", currency: "USD", institution: null }, prisma)
      await prisma.$executeRawUnsafe(`SELECT 1`)
      // A wallet is needed to record a payment; add it in November's draft? Wallets are per employee.
      await sheet.carryForwardEmployees(admin, nov, [{ employeeId: ids.Alexander }], prisma)
      await sheet.updateSheetCell(admin, nov, ids.Alexander, "wallet", "TRvCuZ4fbLRNxsVTY5cN8EqrrwFJ9nFKx3", prisma)
      await sheet.recordPayment(admin, oct, { employeeId: ids.Alexander, amount: new Decimal("500"), currency: "USD", fxRate: null, fee: null, financialAccountId: bank.id, paidAt: new Date("2026-11-03T00:00:00Z"), reference: null }, prisma)
      await assert.rejects(() => sheet.reopenMonth(admin, oct, "late change", prisma), /payments are already recorded/)
    })

    await step("8-10. rollover: selected employees only; future FIX change leaves October; start date unchanged", async () => {
      // Alexander was carried above; Maria is carried with a new FIX.
      await sheet.carryForwardEmployees(admin, nov, [{ employeeId: ids.Maria, fix: "1200", ratePct: "20" }], prisma)
      const m = await row(nov, "Maria")
      assert.deepEqual([m.fix, m.commissionPct, m.proration, m.calculated, m.hireDate, m.kpiActual, m.fact, m.bonus, m.confirmed], ["1200", "20", null, "1200", "2026-10-13", null, null, "0", false])
      const a = await row(nov, "Alexander")
      assert.deepEqual([a.kpiActual, a.fact, a.variable, a.confirmed], [null, null, "0", false], "PROFIT, FACT PAYMENT, bonus and confirmation reset")
      const o = await row(oct, "Maria")
      assert.deepEqual([o.fix, o.approved, o.fixProrated], ["1000", "700", "600"], "October stays as approved")
      assert.deepEqual(await sheet.carryForwardEmployees(admin, nov, [{ employeeId: ids.Maria }], prisma), { added: 0, skipped: 1 }, "no duplicates")
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
