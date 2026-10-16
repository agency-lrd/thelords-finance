/**
 * Transactions and financial reports end to end, on a throwaway PGlite database (never Supabase):
 * double entry, P&L / EBITDA / EBIT / net profit, cash flow reconciliation, balance sheet equation,
 * corrections by reversal, currency conversion, payroll integration and month preservation.
 * Usage: npm run test:reports
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, stop } = await startTestDb(54330)
  const { step, summary } = stepRunner()
  const tx = await import("../src/lib/data/transactions")
  const reports = await import("../src/lib/reports/ledger")
  const { range } = await import("../src/lib/reports/periods")
  const { createFinancialAccount } = await import("../src/lib/data/accounts")
  const sheet = await import("../src/lib/data/sheet")
  const { Decimal } = await import("../src/lib/money")

  try {
    const oct = range("month", 2026, 10)
    const sep = range("month", 2026, 9)
    const d = (day: number, month = 10) => new Date(Date.UTC(2026, month - 1, day))
    const cat = async (code: string) => (await prisma.financialCategory.findFirstOrThrow({ where: { code } })).id
    const bank = await createFinancialAccount(admin, { name: "Bank USD", type: "BANK", currency: "USD", institution: null }, prisma)
    const wallet = await createFinancialAccount(admin, { name: "USDT wallet", type: "CRYPTO_WALLET", currency: "USDT", institution: "TRC20" }, prisma)
    const owner = await prisma.shareholder.create({ data: { organizationId: admin.organizationId, type: "INDIVIDUAL", name: "Owner Test" } })
    const base = {
      fxRate: null, fee: null, financialAccountId: bank.id, counterFinancialAccountId: null, categoryId: null, debitAccountId: null, creditAccountId: null,
      departmentId: null, clientId: null, projectId: null, shareholderId: null, counterparty: null, direction: null, settlementStatus: "PAID" as const,
      dueDate: null, notes: null, attachmentUrl: null, currency: "USD",
    }
    type Input = Parameters<typeof tx.createTransaction>[1]
    const add = (input: Omit<Partial<Input>, "amount"> & { type: Input["type"]; amount: string; date: Date }, post = true) =>
      tx.createTransaction(admin, { ...base, description: input.type, ...input, amount: new Decimal(input.amount) } as Parameters<typeof tx.createTransaction>[1], { post }, prisma)
    const pnl = async (r = oct, filters = {}) => (await reports.pnlReport(admin, r, filters, prisma)).current
    const flow = async (r = oct) => reports.cashFlowReport(admin, r, prisma)
    const bs = async (asOf = oct.to) => (await reports.balanceSheetReport(admin, asOf, prisma)).sheet

    console.log("transactions")
    let expenseId = ""
    let unpaidRevenueId = ""
    await step("post a month of business through every transaction type", async () => {
      await add({ type: "OWNER_CONTRIBUTION", amount: "10000", date: d(1), shareholderId: owner.id })
      await add({ type: "REVENUE", amount: "8000", date: d(3), categoryId: await cat("INFLUENCER-REVENUE") })
      unpaidRevenueId = (await add({ type: "REVENUE", amount: "2000", date: d(4), categoryId: await cat("CLIPPING-REVENUE"), settlementStatus: "UNPAID", financialAccountId: null })).id
      expenseId = (await add({ type: "OPERATING_EXPENSE", amount: "1000", fee: new Decimal("10"), date: d(5), categoryId: await cat("SOFTWARE") })).id
      await add({ type: "OPERATING_EXPENSE", amount: "500", date: d(6), categoryId: await cat("MARKETING"), settlementStatus: "UNPAID", financialAccountId: null })
      await add({ type: "INTERNAL_TRANSFER", amount: "3000", fee: new Decimal("5"), date: d(7), counterFinancialAccountId: wallet.id })
      await add({ type: "LOAN_RECEIVED", amount: "5000", date: d(8) })
      await add({ type: "LOAN_REPAYMENT", amount: "1000", date: d(20) })
      await add({ type: "ASSET_PURCHASE", amount: "1200", date: d(9) })
      await add({ type: "TAX_PAYMENT", amount: "300", date: d(10) })
      await add({ type: "OWNER_WITHDRAWAL", amount: "700", date: d(11), shareholderId: owner.id })
      await add({ type: "REFUND", amount: "200", date: d(12), direction: "OUT", categoryId: await cat("INFLUENCER-REVENUE") })
      await tx.settleTransaction(admin, unpaidRevenueId, { amount: new Decimal("1500"), financialAccountId: bank.id, date: d(15) }, prisma)
    })

    await step("drafts never reach the reports", async () => {
      await add({ type: "REVENUE", amount: "999", date: d(13), categoryId: await cat("MANAGEMENT-FEES") }, false)
      assert.equal((await pnl()).revenue, "9800")
    })

    await step("every posted journal entry is balanced", async () => {
      const rows = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int n FROM (SELECT journal_entry_id FROM journal_lines GROUP BY 1 HAVING sum(debit) <> sum(credit)) x`
      assert.equal(rows[0].n, 0)
    })

    await step("P&L: transfers, owner money and loans never count as revenue", async () => {
      const p = await pnl()
      assert.equal(p.revenue, "9800") // 8,000 + 2,000 - 200 refund
      assert.deepEqual(p.sections.revenue.lines.map((l) => [l.code, l.amount]), [["4020", "7800"], ["4050", "2000"]])
      assert.equal(p.operatingExpenses, "1515") // software 1,000 + marketing 500 + fees 15
      assert.equal(p.ebitda, "8285")
      assert.equal(p.ebit, "8285")
      assert.equal(p.incomeTax, "300")
      assert.equal(p.netProfit, "7985")
      assert.equal(p.margins.net, "81.5")
    })

    await step("cash flow: classified by account, transfers excluded, reconciles with cash accounts", async () => {
      const { flow: f, actualClosing, reconciled } = await flow()
      assert.equal(f.openingCash, "0")
      assert.equal(f.lines.ownerContributions, "10000")
      assert.equal(f.lines.clientReceipts, "9300") // 8,000 + 1,500 received - 200 refunded
      assert.equal(f.lines.operatingPayments, "-1015")
      assert.equal(f.lines.taxesPaid, "-300")
      assert.equal(f.lines.equipmentPurchases, "-1200")
      assert.equal(f.lines.loansReceived, "5000")
      assert.equal(f.lines.loanRepayments, "-1000")
      assert.equal(f.lines.ownerDistributions, "-700")
      assert.equal(f.internalTransfers, "0") // the transfer had a fee line, so it is shown via its fee only
      assert.equal(f.closingCash, "20085")
      assert.equal(actualClosing, "20085")
      assert.equal(reconciled, true)
    })

    await step("balance sheet: assets = liabilities + equity, every group traceable", async () => {
      const b = await bs()
      assert.equal(b.balanced, true)
      assert.equal(b.groups.receivables.total, "500")
      assert.equal(b.groups.payables.total, "500")
      assert.equal(b.groups.shortTermLoans.total, "4000")
      assert.equal(b.groups.fixedAssets.total, "1200")
      assert.equal(b.ownerCapital, "10000")
      assert.equal(b.distributions, "-700")
      assert.equal(b.currentPeriodProfit, "7985")
      assert.equal(b.totalAssets, "21785") // cash 20,085 + receivable 500 + equipment 1,200
    })

    await step("posted transactions are corrected by reversal, and every report follows", async () => {
      await assert.rejects(() => tx.deleteDraft(admin, expenseId, prisma), /reversed, not deleted/)
      await tx.reverseTransaction(admin, expenseId, "entered twice", prisma)
      const p = await pnl()
      assert.equal(p.operatingExpenses, "505")
      assert.equal(p.netProfit, "8995")
      assert.equal((await flow()).flow.closingCash, "21095")
      assert.equal((await bs()).balanced, true)
      const reversed = await prisma.transaction.findUniqueOrThrow({ where: { id: expenseId } })
      assert.equal(reversed.status, "REVERSED")
    })

    await step("drill-down returns the journal lines behind a P&L line", async () => {
      const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { code: "4020" } })
      const lines = await reports.drillDown(admin, account.id, oct, {}, prisma)
      assert.equal(lines.length, 2)
      assert.equal(lines.reduce((a, l) => a + Number(l.credit) - Number(l.debit), 0), 7800)
    })

    await step("currency conversion: EUR revenue is reported at its saved rate", async () => {
      await add({ type: "REVENUE", amount: "100", currency: "EUR", fxRate: new Decimal("1.1"), date: d(2, 11), categoryId: await cat("MANAGEMENT-FEES") })
      assert.equal((await pnl(range("month", 2026, 11))).revenue, "110")
    })

    await step("payroll from the financial sheet lands in the P&L and cash flow", async () => {
      const hr = await prisma.department.findFirstOrThrow({ where: { code: "HR" } })
      const nov = { year: 2026, month: 11 }
      const e = await sheet.addSheetEmployee(admin, nov, { name: "Payroll Test", departmentId: hr.id, fix: "1000", currency: "USD", hireDate: null }, prisma)
      await sheet.updateSheetCell(admin, nov, e.id, "wallet", "TRvCuZ4fbLRNxsVTY5cN8EqrrwFJ9nFKx3", prisma)
      await sheet.setRowConfirmed(admin, nov, e.id, true, prisma)
      await sheet.approveMonth(admin, nov, null, prisma)
      await sheet.recordPayment(admin, nov, { employeeId: e.id, amount: new Decimal("1000"), currency: "USD", fxRate: null, fee: null, financialAccountId: bank.id, paidAt: d(25, 11), reference: null }, prisma)
      const p = await pnl(range("month", 2026, 11))
      assert.deepEqual(p.sections.operatingExpenses.lines.map((l) => [l.code, l.amount]), [["6000", "1000"]]) // HR is overhead
      const f = (await flow(range("month", 2026, 11))).flow
      assert.equal(f.lines.payrollPaid, "-1000")
      assert.equal((await pnl(range("month", 2026, 11), { departmentId: hr.id })).netProfit, "-1000")
    })

    await step("months are preserved: closing cash of one month opens the next; September stays empty", async () => {
      const series = await reports.monthlySeries(admin, 2026, {}, prisma)
      assert.equal(series[9].flow.closingCash, series[10].flow.openingCash)
      assert.equal(series[8].pnl.revenue, "0")
      assert.equal((await pnl(sep)).netProfit, "0")
      assert.equal(series[10].flow.closingCash, (await flow(range("month", 2026, 11))).actualClosing)
    })

    await step("quarter and year reports add up the months", async () => {
      const q4 = await pnl(range("quarter", 2026, 4))
      const y = await pnl(range("year", 2026))
      assert.equal(q4.netProfit, new Decimal("8995").add("110").sub("1000").toString())
      assert.equal(y.netProfit, q4.netProfit)
      assert.equal((await bs(range("month", 2026, 12).to)).balanced, true)
    })

    await step("permissions: posting needs journal:post; reports need reports:read", async () => {
      const clerk = { ...admin, permissions: new Set(["journal:create", "ledger:read"] as const) }
      await assert.rejects(() => tx.createTransaction(clerk as typeof admin, { ...base, type: "OWNER_CONTRIBUTION", description: "x", amount: new Decimal(1), date: d(1, 12), shareholderId: owner.id }, { post: true }, prisma), /journal:post/)
      await assert.rejects(() => reports.pnlReport(clerk as typeof admin, oct, {}, prisma), /permission/)
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
