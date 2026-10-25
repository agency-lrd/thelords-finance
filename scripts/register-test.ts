/**
 * Cash register, owners and Influence teams end to end on a throwaway PGlite database (never Supabase):
 * teams and custom categories with stable order, recurring cost carry-over without copying actuals,
 * client payments vs pass-through budgets, owner distributions and salary payments recorded once and
 * seen everywhere, with no double counting in P&L. All data is fictional. Usage: npm run test:register
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54338)
  const { step, summary } = stepRunner()
  const register = await import("../src/lib/data/cash-register")
  const ledger = await import("../src/lib/data/project-ledger")
  const categories = await import("../src/lib/data/categories")
  const sheet = await import("../src/lib/data/sheet")
  const tx = await import("../src/lib/data/transactions")
  const reports = await import("../src/lib/reports/ledger")
  const { range } = await import("../src/lib/reports/periods")
  const { createFinancialAccount } = await import("../src/lib/data/accounts")
  const { saveOwner } = await import("../src/lib/data/owners")
  const { Decimal } = await import("../src/lib/money")

  const sep = { year: 2026, month: 9 }
  const oct = { year: 2026, month: 10 }
  const influence = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  let wallet = ""
  let teamSanya = ""
  let ownerId = ""
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  const pnl = async (m: typeof oct) => (await reports.pnlReport(admin, range("month", m.year, m.month), {}, prisma)).current
  const cash = async (m: typeof oct) => (await reports.cashFlowReport(admin, range("month", m.year, m.month), prisma)).flow
  const base = { amount: new Decimal(0), currency: "USD", fxRate: null, fee: null, counterFinancialAccountId: null, departmentId: null, clientId: null, clientName: null, clientCategoryId: null, projectId: null, teamId: null, shareholderId: null, categoryId: null, counterparty: null, description: null, notes: null }

  try {
    await step("setup: a USDT wallet", async () => {
      wallet = (await createFinancialAccount(admin, { name: "Main USDT", type: "CRYPTO_WALLET", currency: "USD", institution: null }, prisma)).id
    })

    await step("12. create Influence teams with custom names; order is explicit", async () => {
      teamSanya = (await ledger.createLedgerTeam(admin, influence.id, "Команда Саня", prisma)).id
      const vlad = await ledger.createLedgerTeam(admin, influence.id, "Команда Влад", prisma)
      await assert.rejects(() => ledger.createLedgerTeam(admin, influence.id, "команда саня", prisma), /already exists/)
      let teams = (await ledger.getProjectLedger(admin, oct, prisma)).departments.find((x) => x.id === influence.id)!.teams
      assert.deepEqual(teams.map((x) => x.name), ["Команда Саня", "Команда Влад"])
      await ledger.updateLedgerTeam(admin, vlad.id, { move: "up" }, prisma)
      teams = (await ledger.getProjectLedger(admin, oct, prisma)).departments.find((x) => x.id === influence.id)!.teams
      assert.deepEqual(teams.map((x) => x.name), ["Команда Влад", "Команда Саня"])
    })

    let creators = ""
    await step("13-14. custom income and expense categories are appended, never jump, and can be reordered", async () => {
      const before = (await ledger.getProjectLedger(admin, oct, prisma)).categories.filter((c) => c.kind === "cost").map((c) => c.name)
      creators = (await categories.createCategory(admin, { name: "Creators", kind: "COST_OF_SALES", parentId: null, ledgerAccountId: null }, prisma)).id
      await categories.createCategory(admin, { name: "Аренда студии", kind: "COST_OF_SALES", parentId: null, ledgerAccountId: null }, prisma)
      await categories.createCategory(admin, { name: "Интеграции", kind: "REVENUE", parentId: null, ledgerAccountId: null }, prisma)
      const after = (await ledger.getProjectLedger(admin, oct, prisma)).categories.filter((c) => c.kind === "cost").map((c) => c.name)
      const costKinds = await prisma.financialCategory.findMany({ where: { organizationId: org.id, kind: "COST_OF_SALES", archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
      assert.deepEqual(costKinds.slice(-2).map((c) => c.name), ["Creators", "Аренда студии"], "new categories go to the end of their kind")
      assert.equal(after.length, before.length + 2)
      await categories.moveCategory(admin, creators, "down", prisma)
      const moved = await prisma.financialCategory.findMany({ where: { organizationId: org.id, kind: "COST_OF_SALES", archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
      assert.deepEqual(moved.slice(-2).map((c) => c.name), ["Аренда студии", "Creators"])
      // Renaming keeps the id, so history stays linked.
      await categories.updateCategory(admin, creators, { name: "Creators & UGC" }, prisma)
      assert.equal((await prisma.financialCategory.findUniqueOrThrow({ where: { id: creators } })).name, "Creators & UGC")
    })

    await step("15-16. recurring team costs carry into the next month as plans; actual income is never copied", async () => {
      const income = await ledger.addLedgerEntry(admin, sep, "income", { departmentId: influence.id, item: "Integration X", amount: new Decimal(5000), currency: "USD", categoryId: null, projectId: null, clientId: null, clientName: "Brand A", teamId: teamSanya, date: null, notes: null }, prisma)
      await ledger.setLedgerConfirmed(admin, "income", income.id, true, prisma)
      const rent = await ledger.addLedgerEntry(admin, sep, "cost", { departmentId: influence.id, item: "Studio rent", amount: new Decimal(800), currency: "USD", categoryId: creators, projectId: null, clientId: null, clientName: null, teamId: teamSanya, date: null, notes: null, recurring: true }, prisma)
      await ledger.setLedgerConfirmed(admin, "cost", rent.id, true, prisma)
      await ledger.addLedgerEntry(admin, sep, "cost", { departmentId: influence.id, item: "One-off shoot", amount: new Decimal(300), currency: "USD", categoryId: null, projectId: null, clientId: null, clientName: null, teamId: teamSanya, date: null, notes: null }, prisma)

      const preview = await ledger.recurringCostPreview(admin, oct, prisma)
      assert.deepEqual(preview.rows.map((r) => [r.item, r.amount, r.teamName]), [["Studio rent", "800", "Команда Саня"]], "only recurring costs are offered")
      const octPnlBefore = await pnl(oct)
      assert.deepEqual(await ledger.carryRecurringCosts(admin, oct, [{ id: rent.id, amount: "850" }], prisma), { added: 1, skipped: 0 })
      assert.deepEqual(await ledger.carryRecurringCosts(admin, oct, [{ id: rent.id }], prisma), { added: 0, skipped: 1 }, "no duplicates")
      const octLedger = await ledger.getProjectLedger(admin, oct, prisma)
      assert.equal(octLedger.income.length, 0, "income is never copied")
      assert.deepEqual(octLedger.costs.map((c) => [c.item, c.amount, c.status, c.confirmed, c.teamName, c.recurring]), [["Studio rent", "850", "PLANNED", false, "Команда Саня", true]])
      assert.deepEqual(await pnl(oct), octPnlBefore, "a carried plan is not in the P&L until confirmed")
      const sepRent = await prisma.projectCost.findUniqueOrThrow({ where: { id: rent.id } })
      assert.equal(sepRent.amount.toString(), "800", "September is unchanged")
    })

    await step("17-18. client payment: cash in, revenue recognized, client created with its category; pass-through budget is cash but not revenue", async () => {
      const casino = await prisma.clientCategory.findFirstOrThrow({ where: { organizationId: org.id, name: "Casino" } })
      await register.recordMovement(admin, { ...base, kind: "CLIENT_PAYMENT", date: d("2026-10-05"), amount: new Decimal(10000), financialAccountId: wallet, departmentId: influence.id, clientName: "Stake Test", clientCategoryId: casino.id, teamId: teamSanya }, prisma)
      await register.recordMovement(admin, { ...base, kind: "CLIENT_BUDGET", date: d("2026-10-06"), amount: new Decimal(20000), financialAccountId: wallet, departmentId: influence.id, clientName: "stake test" }, prisma)
      assert.equal(await prisma.client.count({ where: { organizationId: org.id, name: { equals: "Stake Test", mode: "insensitive" } } }), 1, "the same advertiser is reused")
      const p = await pnl(oct)
      assert.equal(p.revenue, "10000", "the pass-through budget is not revenue")
      const f = await cash(oct)
      assert.equal(f.lines.clientReceipts, "10000")
      assert.equal(f.lines.clientBudgets, "20000")
      assert.equal(f.closingCash, "30000")
      const report = await register.clientReport(admin, d("2026-10-01"), d("2026-10-31"), prisma)
      const stake = report.clients.find((c) => c.name === "Stake Test")!
      assert.deepEqual([stake.cash, stake.budgets, stake.revenue, stake.category], ["10000", "20000", "10000", "Casino"])
      assert.equal(report.departments.find((x) => x.name === influence.name)!.revenue, "10000")
      assert.equal((await tx.listTransactions(admin, {}, prisma)).find((r) => r.kind === "CLIENT_PAYMENT")!.team, "Команда Саня")
    })

    await step("19-20. owner distribution from Owners: one transaction, in Transactions, Owners and Cash Flow, not in profit", async () => {
      ownerId = await saveOwner(admin, { id: null, name: "Owner One", type: "INDIVIDUAL", email: null }, prisma)
      const before = await pnl(oct)
      await register.recordMovement(admin, { ...base, kind: "OWNER_DISTRIBUTION", date: d("2026-10-20"), amount: new Decimal(3000), financialAccountId: wallet, shareholderId: ownerId }, prisma)
      const list = (await tx.listTransactions(admin, {}, prisma)).filter((r) => r.kind === "OWNER_DISTRIBUTION")
      assert.equal(list.length, 1)
      const owners = (await register.ownerMovements(admin, prisma)).filter((r) => r.kind === "OWNER_DISTRIBUTION")
      assert.deepEqual(owners.map((o) => o.id), list.map((l) => l.id), "the same record")
      assert.equal((await cash(oct)).lines.ownerDistributions, "-3000")
      assert.deepEqual(await pnl(oct), before, "distributions never reduce profit")
      // Investor capital return reduces owner capital, still not profit.
      await register.recordMovement(admin, { ...base, kind: "INVESTOR_CONTRIBUTION", date: d("2026-10-02"), amount: new Decimal(5000), financialAccountId: wallet, shareholderId: ownerId }, prisma)
      await register.recordMovement(admin, { ...base, kind: "INVESTOR_CAPITAL_RETURN", date: d("2026-10-25"), amount: new Decimal(1000), financialAccountId: wallet, shareholderId: ownerId }, prisma)
      assert.equal((await cash(oct)).lines.ownerContributions, "4000")
      assert.deepEqual(await pnl(oct), before)
    })

    await step("transfers between own accounts are neither income nor expense", async () => {
      const bank = await createFinancialAccount(admin, { name: "Bank USD", type: "BANK", currency: "USD", institution: null }, prisma)
      const before = await pnl(oct)
      await register.recordMovement(admin, { ...base, kind: "TRANSFER", date: d("2026-10-21"), amount: new Decimal(2000), financialAccountId: wallet, counterFinancialAccountId: bank.id }, prisma)
      const f = await cash(oct)
      assert.equal(f.internalTransfers, "2000")
      assert.deepEqual(await pnl(oct), before)
    })

    await step("21-23. salary payment: one payroll payment, in Transactions and Cash Flow; the P&L expense is not duplicated", async () => {
      const e = await sheet.addSheetEmployee(admin, sep, { name: "Pay Test", departmentId: influence.id, fix: "1000", currency: "USD", hireDate: d("2026-01-01") }, prisma)
      await sheet.setRowConfirmed(admin, sep, e.id, true, prisma)
      await sheet.approveMonth(admin, sep, null, prisma)
      await sheet.carryForwardEmployees(admin, oct, [{ employeeId: e.id }], prisma)
      await sheet.updateSheetCell(admin, oct, e.id, "wallet", "TRvCuZ4fbLRNxsVTY5cN8EqrrwFJ9nFKx3", prisma)
      const septPnl = await pnl(sep)
      const octPnl = await pnl(oct)
      const due = await register.payslipsToPay(admin, prisma)
      assert.deepEqual(due.map((x) => [x.name, x.month, x.outstanding]), [["Pay Test", "2026-09", "1000"]])
      await register.paySalary(admin, { payrollItemId: due[0].payrollItemId, amount: new Decimal(600), currency: "USD", fxRate: null, fee: null, financialAccountId: wallet, paidAt: d("2026-10-10"), reference: null }, prisma)
      assert.deepEqual((await register.payslipsToPay(admin, prisma)).map((x) => x.outstanding), ["400"], "partial payment")
      const payments = await register.listSalaryPayments(admin, {}, prisma)
      assert.deepEqual(payments.map((p) => [p.employee, p.payrollMonth, p.amount]), [["Pay Test", "2026-09", "600"]])
      assert.equal((await cash(oct)).lines.payrollPaid, "-600")
      assert.deepEqual(await pnl(sep), septPnl, "the salary expense stays in the payroll month")
      assert.deepEqual(await pnl(oct), octPnl, "paying adds no second expense")
      await assert.rejects(() => register.paySalary(admin, { payrollItemId: due[0].payrollItemId, amount: new Decimal(500), currency: "USD", fxRate: null, fee: null, financialAccountId: wallet, paidAt: d("2026-10-11"), reference: null }, prisma), /larger than the outstanding/)
    })

    await step("27. renaming a department, team or client category keeps every relationship", async () => {
      await ledger.updateLedgerTeam(admin, teamSanya, { name: "Команда Александр" }, prisma)
      const casino = await prisma.clientCategory.findFirstOrThrow({ where: { organizationId: org.id, name: "Casino" } })
      await register.saveClientCategory(admin, { id: casino.id, name: "Casino / iGaming" }, prisma)
      const report = await register.clientReport(admin, d("2026-10-01"), d("2026-10-31"), prisma)
      assert.equal(report.clients.find((c) => c.name === "Stake Test")!.category, "Casino / iGaming")
      assert.equal((await tx.listTransactions(admin, {}, prisma)).find((r) => r.kind === "CLIENT_PAYMENT")!.team, "Команда Александр")
      await assert.rejects(() => register.saveClientCategory(admin, { id: null, name: "casino / igaming" }, prisma), /already exists/)
    })

    await step("24. employee count: distinct people on the month's sheet, never all profiles or payslips", async () => {
      const analytics = await import("../src/lib/reports/analytics")
      // Extra profiles never on October's sheet, and an archived one: none of them count.
      for (const n of ["Ghost One", "Ghost Two"]) await prisma.employee.create({ data: { organizationId: org.id, employeeNumber: `G-${n}`, firstName: n, lastName: "", hireDate: d("2025-01-01"), status: "ACTIVE" } })
      const extra = await sheet.addSheetEmployee(admin, oct, { name: "Archived Later", departmentId: influence.id, fix: "500", currency: "USD", hireDate: d("2026-01-01") }, prisma)
      await sheet.setEmployeeArchived(admin, extra.id, true, prisma)
      const months = (await analytics.monthlyAnalytics(admin, 2026, prisma)).months
      const octRows = (await sheet.getSheet(admin, oct, prisma)).rows.length
      assert.equal(months[9].employees, octRows, "October analytics = people on October's sheet")
      assert.equal(months[8].employees, 1, "September: one person (approved payslip), not counted twice")
      const defs = (await analytics.monthlyAnalytics(admin, 2026, prisma)).definitions.map((x) => x.code)
      assert.ok(!defs.includes("CLIENT_NPS") && !defs.includes("EMPLOYEE_NPS"), "NPS is no longer shown")
    })

    await step("25. report gaps: unapproved payroll and unconfirmed rows are listed; directions view is filtered", async () => {
      const gaps = await import("../src/lib/reports/gaps")
      const g = await gaps.reportGaps(admin, range("month", 2026, 10), prisma)
      assert.deepEqual(g.payrollNotApproved.map((x) => x.month), ["2026-10"])
      assert.equal(g.plannedCosts.count, 1, "the carried plan is listed as not included")
      const dir = await gaps.directionGross(admin, range("month", 2026, 10), prisma)
      assert.deepEqual(dir.rows.map((r) => r.name), [influence.name, ...dir.rows.slice(1).map((r) => r.name)])
      assert.equal(dir.rows[0].revenue, "10000")
      const balances = await gaps.accountBalances(admin, d("2026-10-31"), prisma)
      const total = balances.reduce((a, b) => a + Number(b.balance), 0)
      assert.equal(String(total), (await cash(oct)).closingCash, "account balances add up to closing cash")
    })

    await step("department and team analytics: one month with the change from the previous month", async () => {
      const analytics = await import("../src/lib/reports/analytics")
      const a = await analytics.departmentAnalytics(admin, oct, prisma)
      const inf = a.departments.find((x) => x.id === influence.id)!
      assert.equal(inf.current.revenue, "10000")
      assert.equal(inf.previous.payroll, "1000", "September's approved payroll")
      const team = a.teams.find((x) => x.name === "Команда Александр")!
      assert.equal(team.previous.revenue, "5000")
      assert.equal(team.previous.direct, "800")
    })

    await step("AI CFO plans: a fixed plan cannot change; plan vs actual vs variance; nothing operational is written", async () => {
      const plans = await import("../src/lib/data/plans")
      const before = await prisma.transaction.count()
      const id = await plans.savePlan(admin, { name: "October base", month: oct, assumptions: "2 new hires", revenue: new Decimal(12000), directCosts: null, operatingExpenses: null, payroll: new Decimal(1000), hiringCost: new Decimal(500), profit: null, cashBalance: new Decimal(25000), fix: true }, prisma)
      await assert.rejects(() => plans.savePlan(admin, { id, name: "Changed", month: oct, assumptions: null, revenue: new Decimal(1), directCosts: null, operatingExpenses: null, payroll: null, hiringCost: null, profit: null, cashBalance: null, fix: false }, prisma), /fixed/)
      await prisma.$executeRawUnsafe(`CREATE TEMP TABLE IF NOT EXISTS rule_result (message text); TRUNCATE rule_result;`)
      await prisma.$executeRawUnsafe(`DO $$ BEGIN BEGIN UPDATE financial_plans SET revenue = 1 WHERE id = '${id}'; INSERT INTO rule_result VALUES ('accepted'); EXCEPTION WHEN OTHERS THEN INSERT INTO rule_result VALUES (SQLERRM); END; END $$;`)
      const [res] = await prisma.$queryRawUnsafe<{ message: string }[]>(`SELECT message FROM rule_result`)
      assert.match(res.message, /cannot be changed/)
      const [p] = await plans.plansWithActuals(admin, oct, prisma)
      assert.deepEqual([p.rows.revenue.plan, p.rows.revenue.actual, p.rows.revenue.variance, p.rows.revenue.variancePct], ["12000", "10000", "-2000", "-16.7"])
      assert.equal(p.rows.profit.plan, "10500", "expected profit = revenue - payroll - hiring")
      assert.equal(await prisma.transaction.count(), before)
      await plans.archivePlan(admin, id, true, prisma)
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
