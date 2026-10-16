import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { allocateDistribution, buildBalanceSheet, buildCashFlow, buildPnl, growth, percent, type AccountActivity, type EntryLine } from "./statements"

const acct = (code: string, type: AccountActivity["type"], subtype: string, debit: string, credit: string, cfa = "OPERATING"): AccountActivity => ({
  accountId: `a${code}`,
  code,
  name: `Account ${code}`,
  type,
  subtype,
  cashFlowActivity: cfa,
  debit,
  credit,
})

// A small month of activity, expressed as account totals.
const month: AccountActivity[] = [
  acct("4020", "REVENUE", "OPERATING_REVENUE", "0", "10000"),
  acct("4050", "REVENUE", "OPERATING_REVENUE", "500", "3000"), // includes a 500 refund
  acct("5400", "EXPENSE", "COST_OF_SALES", "4000", "0"),
  acct("5000", "EXPENSE", "COST_OF_SALES", "2000", "0"),
  acct("6000", "EXPENSE", "OPERATING_EXPENSE", "1500", "0"),
  acct("6100", "EXPENSE", "OPERATING_EXPENSE", "300", "100"),
  acct("7000", "EXPENSE", "DEPRECIATION", "200", "0"),
  acct("7100", "EXPENSE", "AMORTIZATION", "50", "0"),
  acct("8000", "EXPENSE", "INTEREST_EXPENSE", "120", "0"),
  acct("8100", "REVENUE", "INTEREST_INCOME", "0", "20"),
  acct("9000", "EXPENSE", "INCOME_TAX", "750", "0"),
  acct("1010", "ASSET", "CASH", "9000", "1000"), // balance sheet accounts are ignored by the P&L
]

describe("buildPnl", () => {
  const p = buildPnl(month)
  it("revenue, gross profit and margins", () => {
    assert.equal(p.revenue, "12500")
    assert.equal(p.costOfServices, "6000")
    assert.equal(p.grossProfit, "6500")
    assert.equal(p.margins.gross, "52")
  })
  it("EBITDA excludes depreciation and amortization; EBIT includes them", () => {
    assert.equal(p.operatingExpenses, "1700")
    assert.equal(p.ebitda, "4800")
    assert.equal(p.ebit, "4550")
    assert.equal(p.margins.ebitda, "38.4")
  })
  it("interest is below EBIT, tax below profit before tax", () => {
    assert.equal(p.nonOperating, "-100")
    assert.equal(p.profitBeforeTax, "4450")
    assert.equal(p.netProfit, "3700")
    assert.equal(p.margins.net, "29.6")
  })
  it("lines come from accounts and add up to their section", () => {
    assert.deepEqual(p.sections.revenue.lines.map((l) => [l.code, l.amount]), [["4020", "10000"], ["4050", "2500"]])
    assert.equal(p.totalExpenses, "8820") // 6,000 + 1,700 + 250 + 120 + 750
  })
  it("zero revenue gives no margins instead of dividing by zero", () => {
    const empty = buildPnl([acct("6000", "EXPENSE", "OPERATING_EXPENSE", "100", "0")])
    assert.equal(empty.netProfit, "-100")
    assert.deepEqual(empty.margins, { gross: null, ebitda: null, ebit: null, net: null })
  })
})

describe("percent and growth", () => {
  it("handles zero and missing denominators", () => {
    assert.equal(percent(1, 0), null)
    assert.equal(growth(100, 0), null)
    assert.equal(growth(100, null), null)
    assert.equal(growth(150, 100), "50")
    assert.equal(growth(-50, -100), "50") // loss shrank: improvement
  })
})

describe("buildBalanceSheet", () => {
  // Cumulative balances that come from balanced entries:
  //  capital 10,000 in cash; prior-year profit 1,000 (revenue 3,000 - costs 2,000 cash);
  //  this year revenue 5,000 on account (receivable), payroll 2,000 accrued (payable),
  //  equipment 1,500 bought for cash, 300 distributed to owners.
  const cumulative: AccountActivity[] = [
    acct("1010", "ASSET", "CASH", "13000", "3800"),
    acct("1200", "ASSET", "RECEIVABLE", "5000", "0"),
    acct("1500", "ASSET", "FIXED_ASSET", "1500", "0"),
    acct("2100", "LIABILITY", "PAYROLL_LIABILITY", "0", "2000"),
    acct("3000", "EQUITY", "OWNER_CAPITAL", "0", "10000"),
    acct("3200", "EQUITY", "DISTRIBUTIONS", "300", "0"),
    acct("4000", "REVENUE", "OPERATING_REVENUE", "0", "8000"),
    acct("6000", "EXPENSE", "OPERATING_EXPENSE", "4000", "0"),
  ]
  const currentYear: AccountActivity[] = [acct("4000", "REVENUE", "OPERATING_REVENUE", "0", "5000"), acct("6000", "EXPENSE", "OPERATING_EXPENSE", "2000", "0")]
  const b = buildBalanceSheet(cumulative, currentYear)
  it("assets = liabilities + equity", () => {
    assert.equal(b.totalAssets, "15700")
    assert.equal(b.totalLiabilities, "2000")
    assert.equal(b.retainedEarnings, "1000")
    assert.equal(b.currentPeriodProfit, "3000")
    assert.equal(b.distributions, "-300")
    assert.equal(b.totalEquity, "13700")
    assert.equal(b.difference, "0")
    assert.equal(b.balanced, true)
  })
  it("reports, never hides, a difference", () => {
    const broken = buildBalanceSheet([...cumulative, acct("1400", "ASSET", "PREPAID", "10", "0")], currentYear)
    assert.equal(broken.balanced, false)
    assert.equal(broken.difference, "10")
  })
})

describe("buildCashFlow", () => {
  const cash = new Set(["bank", "wallet"])
  const L = (accountId: string, type: EntryLine["type"], subtype: string, debit: string, credit: string): EntryLine => ({ accountId, type, subtype, debit, credit })
  const entries = [
    { lines: [L("bank", "ASSET", "CASH", "8000", "0"), L("ar", "ASSET", "RECEIVABLE", "0", "8000")] }, // client paid
    { lines: [L("pp", "LIABILITY", "PAYROLL_LIABILITY", "3000", "0"), L("wallet", "ASSET", "CASH", "0", "3000")] }, // salaries
    { lines: [L("sw", "EXPENSE", "OPERATING_EXPENSE", "200", "0"), L("bank", "ASSET", "CASH", "0", "200")] },
    { lines: [L("wallet", "ASSET", "CASH", "5000", "0"), L("bank", "ASSET", "CASH", "0", "5000")] }, // internal transfer
    { lines: [L("bank", "ASSET", "CASH", "10000", "0"), L("loan", "LIABILITY", "LONG_TERM_DEBT", "0", "10000")] },
    { lines: [L("eq", "ASSET", "FIXED_ASSET", "1200", "0"), L("bank", "ASSET", "CASH", "0", "1200")] },
    { lines: [L("cap", "EQUITY", "OWNER_CAPITAL", "0", "2000"), L("bank", "ASSET", "CASH", "2000", "0")] },
    { lines: [L("dist", "EQUITY", "DISTRIBUTIONS", "1000", "0"), L("bank", "ASSET", "CASH", "0", "1000")] },
    { lines: [L("rev", "REVENUE", "OPERATING_REVENUE", "0", "900"), L("ar", "ASSET", "RECEIVABLE", "900", "0")] }, // no cash: ignored
  ]
  const cf = buildCashFlow("1000", entries, (id) => cash.has(id))
  it("classifies by account, not by description", () => {
    assert.equal(cf.lines.clientReceipts, "8000")
    assert.equal(cf.lines.payrollPaid, "-3000")
    assert.equal(cf.lines.operatingPayments, "-200")
    assert.equal(cf.lines.loansReceived, "10000")
    assert.equal(cf.lines.equipmentPurchases, "-1200")
    assert.equal(cf.lines.ownerContributions, "2000")
    assert.equal(cf.lines.ownerDistributions, "-1000")
  })
  it("internal transfers are not cash flow", () => {
    assert.equal(cf.internalTransfers, "5000")
    assert.equal(cf.inflow, "20000")
    assert.equal(cf.outflow, "5400")
  })
  it("opening + net change = closing, and matches the cash accounts", () => {
    assert.equal(cf.operating, "4800")
    assert.equal(cf.investing, "-1200")
    assert.equal(cf.financing, "11000")
    assert.equal(cf.netChange, "14600")
    assert.equal(cf.closingCash, "15600")
    // Independent check: sum of all cash-line movements.
    const moved = entries.flatMap((e) => e.lines).filter((l) => cash.has(l.accountId)).reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)
    assert.equal(1000 + moved, 15600)
  })
})

describe("allocateDistribution", () => {
  it("spec example: $20,000 at 25/25/50", () => {
    const r = allocateDistribution("20000", [{ id: "A", share: "0.25" }, { id: "B", share: "0.25" }, { id: "C", share: "0.5" }])
    assert.deepEqual(r.allocations.map((a) => [a.id, a.amount]), [["A", "5000"], ["B", "5000"], ["C", "10000"]])
    assert.equal(r.retained, "0")
  })
  it("rounding remainder goes to the largest holder; total stays exact", () => {
    const r = allocateDistribution("100", [{ id: "A", share: "0.3333" }, { id: "B", share: "0.3333" }, { id: "C", share: "0.3334" }])
    const sum = r.allocations.reduce((a, x) => a + Number(x.amount), 0)
    assert.equal(sum.toFixed(2), "100.00")
  })
  it("shares under 100% leave the rest retained", () => {
    const r = allocateDistribution("1000", [{ id: "A", share: "0.6" }])
    assert.equal(r.allocated, "600")
    assert.equal(r.retained, "400")
  })
  it("refuses impossible inputs", () => {
    assert.throws(() => allocateDistribution("0", [{ id: "A", share: "1" }]))
    assert.throws(() => allocateDistribution("10", [{ id: "A", share: "0.7" }, { id: "B", share: "0.4" }]))
  })
})
