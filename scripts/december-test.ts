/**
 * December 2026 department view end to end on a throwaway PGlite database (never Supabase): department
 * rosters, recurring and one-time costs, income and profitability per department, November -> December
 * carry-over, wallets, large/decimal amounts, manual KPI bonus override, FACT PAYMENT, approval and
 * unchanged history. All data is synthetic. Usage: npm run test:december
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54339)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const ledger = await import("../src/lib/data/project-ledger")
  const adminOps = await import("../src/lib/data/sheet-admin")
  const reports = await import("../src/lib/reports/ledger")
  const { range } = await import("../src/lib/reports/periods")
  const { Decimal } = await import("../src/lib/money")
  const view = await import("../src/lib/department-view")

  const nov = { year: 2026, month: 11 }
  const dec = { year: 2026, month: 12 }
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  const influence = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  const aiProduction = (await prisma.department.findFirst({ where: { organizationId: org.id, name: "AI Production" } })) ?? (await adminOps.createSheetDepartment(admin, { name: "AI Production", color: null, costClassification: "COST_OF_SALES" }, prisma))
  const ids: Record<string, string> = {}
  const rows = async (m: typeof dec) => (await sheet.getSheet(admin, m, prisma)).rows
  const row = async (m: typeof dec, name: string) => (await rows(m)).find((r) => r.employeeId === ids[name])!
  const edit = (m: typeof dec, name: string, field: Parameters<typeof sheet.updateSheetCell>[3], value: string, reason?: string) => sheet.updateSheetCell(admin, m, ids[name], field, value, prisma, undefined, undefined, reason)
  const pnl = async (m: typeof dec) => (await reports.pnlReport(admin, range("month", m.year, m.month), {}, prisma)).current
  const cost = (m: typeof dec, departmentId: string, item: string, amount: string, recurring: boolean) =>
    ledger.addLedgerEntry(admin, m, "cost", { departmentId, item, amount: new Decimal(amount), currency: "USD", categoryId: null, projectId: null, clientId: null, clientName: null, teamId: null, date: null, notes: null, recurring }, prisma)
  let novSnapshot = ""
  let novCosts = ""

  try {
    await step("department tabs: main directions first, from November 2026", async () => {
      const ordered = view.orderDepartmentTabs([{ name: "HR" }, { name: "Influence" }, { name: "Запуски курсов" }, { name: "Traffic CPA" }, { name: "AI Production" }])
      assert.deepEqual(ordered.map((x) => x.name), ["AI Production", "Influence", "Traffic CPA", "Запуски курсов", "HR"])
      assert.equal(view.departmentViewActive("2026-10"), false)
      assert.equal(view.departmentViewActive("2026-11"), true, "activation date: November 2026")
      assert.equal(view.departmentViewActive("2027-01"), true)
    })

    await step("November: employees in two departments, recurring costs, approved", async () => {
      ids.Ann = (await sheet.addSheetEmployee(admin, nov, { name: "Ann Influence", departmentId: influence.id, fix: "1000", currency: "USD", hireDate: d("2026-01-01") }, prisma)).id
      ids.Bob = (await sheet.addSheetEmployee(admin, nov, { name: "Bob AI", departmentId: aiProduction.id, fix: "2000", currency: "USD", hireDate: d("2026-03-01") }, prisma)).id
      const tool = await cost(nov, aiProduction.id, "GPU cloud", "500", true)
      await ledger.setLedgerConfirmed(admin, "cost", tool.id, true, prisma)
      const income = await ledger.addLedgerEntry(admin, nov, "income", { departmentId: influence.id, item: "November campaign", amount: new Decimal(7000), currency: "USD", categoryId: null, projectId: null, clientId: null, clientName: "Synthetic Brand", teamId: null, date: null, notes: null }, prisma)
      await ledger.setLedgerConfirmed(admin, "income", income.id, true, prisma)
      for (const n of ["Ann", "Bob"]) await sheet.setRowConfirmed(admin, nov, ids[n], true, prisma)
      await sheet.approveMonth(admin, nov, null, prisma)
      // Payroll content of the approved month (the wallet is employee data, editable any time).
      novSnapshot = JSON.stringify((await rows(nov)).map((r) => ({ ...r, wallet: undefined })))
      novCosts = JSON.stringify(await prisma.projectCost.findMany({ where: { period: { year: 2026, month: 11 } }, orderBy: { createdAt: "asc" } }))
    })

    await step("1-4. December: carried employees; each department shows only its own people and totals", async () => {
      await sheet.carryForwardEmployees(admin, dec, [{ employeeId: ids.Ann }, { employeeId: ids.Bob }], prisma)
      const all = await rows(dec)
      const inf = all.filter((r) => r.departmentId === influence.id)
      const ai = all.filter((r) => r.departmentId === aiProduction.id)
      assert.deepEqual(inf.map((r) => r.name), ["Ann Influence"])
      assert.deepEqual(ai.map((r) => r.name), ["Bob AI"])
      assert.equal(ai.reduce((a, r) => a + Number(r.payable), 0), 2000)
      assert.equal((await row(dec, "Ann")).hireDate, "2026-01-01", "start date unchanged")
    })

    let recurringId = ""
    await step("5-8. recurring cost (added, edited), one-time cost and income for a department", async () => {
      recurringId = (await cost(dec, influence.id, "Analytics tool", "300", true)).id
      await ledger.updateLedgerEntry(admin, "cost", recurringId, { amount: new Decimal("350.75") }, prisma)
      const oneTime = await cost(dec, influence.id, "Event booth", "1250000", false)
      const income = await ledger.addLedgerEntry(admin, dec, "income", { departmentId: influence.id, item: "December campaign", amount: new Decimal("25750.50"), currency: "USD", categoryId: null, projectId: null, clientId: null, clientName: "Synthetic Brand", teamId: null, date: null, notes: null }, prisma)
      for (const [k, id] of [["cost", recurringId], ["cost", oneTime.id], ["income", income.id]] as const) await ledger.setLedgerConfirmed(admin, k, id, true, prisma)
      const l = await ledger.getProjectLedger(admin, dec, prisma)
      const infCosts = l.costs.filter((c) => c.departmentId === influence.id)
      assert.deepEqual(infCosts.filter((c) => c.recurring).map((c) => [c.item, c.amount]), [["Analytics tool", "350.75"]])
      assert.deepEqual(infCosts.filter((c) => !c.recurring).map((c) => [c.item, c.amount]), [["Event booth", "1250000"]])
      assert.equal(l.income.filter((c) => c.departmentId === influence.id)[0].amount, "25750.5")
      assert.equal(l.costs.filter((c) => c.departmentId === aiProduction.id).length, 0, "records never mix between departments")
    })

    await step("11-12. recurring costs carried from November with an edited amount; November and its income unchanged", async () => {
      const preview = await ledger.recurringCostPreview(admin, dec, prisma)
      const gpu = preview.rows.find((r) => r.item === "GPU cloud")!
      assert.equal(gpu.departmentId, aiProduction.id)
      assert.deepEqual(await ledger.carryRecurringCosts(admin, dec, [{ id: gpu.id, amount: "650" }], prisma), { added: 1, skipped: 0 })
      const l = await ledger.getProjectLedger(admin, dec, prisma)
      const carried = l.costs.find((c) => c.item === "GPU cloud")!
      assert.deepEqual([carried.amount, carried.status, carried.confirmed, carried.recurring], ["650", "PLANNED", false, true])
      assert.equal(l.income.filter((i) => i.item === "November campaign").length, 0, "actual income is never copied")
      assert.equal(JSON.stringify(await prisma.projectCost.findMany({ where: { period: { year: 2026, month: 11 } }, orderBy: { createdAt: "asc" } })), novCosts)
    })

    await step("13-15. wallet: add (also in an approved month), edit, free-text destination, persists, clear", async () => {
      await edit(nov, "Ann", "wallet", "TRvCuZ4fbLRNxsVTY5cN8EqrrwFJ9nFKx3")
      let w = (await row(dec, "Ann")).wallet!
      assert.deepEqual([w.network, w.masked], ["TRC20", "TRvCuZ…nFKx3".replace("nFKx3", "FKx3")])
      await edit(dec, "Ann", "wallet", "Binance Pay ID 123 456 789")
      w = (await row(dec, "Ann")).wallet!
      assert.equal(w.network, null)
      assert.equal(await sheet.revealWallet(admin, w.id, prisma), "Binance Pay ID 123 456 789", "persists (reloaded from the database)")
      await assert.rejects(() => edit(dec, "Ann", "wallet", "x"), /3 to 200/)
      assert.equal(await prisma.payoutWallet.count({ where: { employeeId: ids.Ann } }), 2, "the previous wallet is archived, not deleted")
      assert.equal((await row(nov, "Ann")).confirmed, true, "a wallet change never touches the approved month")
      await edit(dec, "Ann", "wallet", "")
      assert.equal((await row(dec, "Ann")).wallet, null)
      await edit(dec, "Ann", "wallet", "TRvCuZ4fbLRNxsVTY5cN8EqrrwFJ9nFKx3")
    })

    await step("16-21. KPI 3,000 / PROFIT 4,000 -> 100; large and decimal amounts saved exactly", async () => {
      await edit(dec, "Bob", "kpiTarget", "3000")
      await edit(dec, "Bob", "kpiActual", "4000")
      assert.equal((await row(dec, "Bob")).variable, "100")
      await edit(dec, "Bob", "kpiTarget", "25000")
      await edit(dec, "Bob", "kpiActual", "125000.50")
      const r = await row(dec, "Bob")
      assert.deepEqual([r.kpiTarget, r.kpiActual, r.variable], ["25000", "125000.5", "10000.05"])
      await edit(dec, "Bob", "fix", "1250000")
      assert.equal((await row(dec, "Bob")).fix, "1250000")
      await edit(dec, "Bob", "fix", "2000")
    })

    await step("22-23. KPI bonus changed manually (who/why kept, replaces the formula), then automatic again", async () => {
      await assert.rejects(() => edit(dec, "Bob", "kpiBonus", "7000"), /reason/)
      await edit(dec, "Bob", "kpiBonus", "7000", "Agreed with the owner")
      let r = await row(dec, "Bob")
      assert.deepEqual([r.variable, r.kpiBonusAuto, r.kpiBonusOverride, r.kpiBonusReason, r.kpiBonusBy, r.calculated], ["7000", "10000.05", "7000", "Agreed with the owner", admin.email, "9000"])
      await edit(dec, "Bob", "kpiActual", "200000")
      r = await row(dec, "Bob")
      assert.deepEqual([r.variable, r.kpiBonusAuto], ["7000", "17500"], "PROFIT changes never overwrite the manual bonus")
      await edit(dec, "Bob", "kpiBonus", "")
      r = await row(dec, "Bob")
      assert.deepEqual([r.variable, r.kpiBonusOverride, r.calculated], ["17500", null, "19500"])
      await edit(dec, "Bob", "kpiActual", "4000")
      await edit(dec, "Bob", "kpiTarget", "3000")
      await edit(dec, "Bob", "kpiBonus", "250", "Rounded up")
    })

    await step("24-26. manual bonus, FACT PAYMENT, confirmation and approval; the payslip has no double bonus", async () => {
      await edit(dec, "Ann", "bonus", "150")
      await edit(dec, "Ann", "fact", "1200")
      let r = await row(dec, "Ann")
      assert.deepEqual([r.calculated, r.fact, r.payable], ["1150", "1200", "1200"])
      for (const n of ["Ann", "Bob"]) await sheet.setRowConfirmed(admin, dec, ids[n], true, prisma)
      await sheet.approveMonth(admin, dec, null, prisma)
      r = await row(dec, "Bob")
      assert.deepEqual([r.approved, r.variable], ["2250", "250"])
      const item = await prisma.payrollItem.findFirstOrThrow({ where: { employeeId: ids.Bob, payrollRun: { period: { year: 2026, month: 12 } } }, include: { lines: true } })
      assert.deepEqual(item.lines.filter((l) => l.lineType !== "BASE_SALARY").map((l) => [l.lineType, l.amount.toString()]), [["KPI_BONUS", "250"]], "the manual bonus replaces the automatic one")
    })

    await step("9-10, 27-28. department profit; payroll and records counted once in the P&L; November untouched", async () => {
      const l = await ledger.getProjectLedger(admin, dec, prisma)
      const confirmed = (list: { departmentId: string | null; confirmed: boolean; baseAmount: string }[], dept: string) => list.filter((x) => x.departmentId === dept && x.confirmed).reduce((a, x) => a + Number(x.baseAmount), 0)
      const payroll = (await rows(dec)).filter((r) => r.departmentId === influence.id).reduce((a, r) => a + Number(r.approved), 0)
      const profit = confirmed(l.income, influence.id) - confirmed(l.costs, influence.id) - payroll
      assert.equal(profit, 25750.5 - 350.75 - 1250000 - 1200)
      const p = await pnl(dec)
      assert.equal(p.revenue, "25750.5", "each income counted once")
      assert.equal(Number(p.costOfServices) + Number(p.operatingExpenses), 350.75 + 1250000 + 1200 + 2250, "costs + approved payroll, each once (the carried plan is not confirmed)")
      assert.equal(JSON.stringify((await rows(nov)).map((r) => ({ ...r, wallet: undefined }))), novSnapshot, "November's approved payroll is unchanged")
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
