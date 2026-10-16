/**
 * Financial statements from ledger balances. Pure and deterministic: these functions are the only place
 * where P&L, balance sheet and cash flow lines are classified and totalled, so every page, export and
 * the AI CFO tools show the same numbers.
 *
 * Classification uses the chart of accounts (account type, subtype and cash-flow activity), never the
 * text of transactions. Amounts are base-currency decimal strings; math uses decimal.js.
 */
import Decimal from "decimal.js"

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE"

/** Debit/credit activity of one ledger account over a period (or cumulative to a date). */
export type AccountActivity = {
  accountId: string
  code: string
  name: string
  type: AccountType
  subtype: string
  cashFlowActivity: string
  debit: string
  credit: string
}

export type Line = { accountId: string; code: string; name: string; amount: string }
export type Section = { key: string; lines: Line[]; total: string }

const ZERO = new Decimal(0)
const sumOf = (lines: { amount: string }[]) => lines.reduce((acc, l) => acc.add(l.amount), ZERO)
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code)

/** Natural-sign balance: debit-normal types (assets, expenses) = debit - credit; others = credit - debit. */
export function naturalAmount(a: Pick<AccountActivity, "type" | "debit" | "credit">) {
  const net = new Decimal(a.debit).sub(a.credit)
  return a.type === "ASSET" || a.type === "EXPENSE" ? net : net.neg()
}

/** Ratio as a percentage string with 1 decimal, or null when the denominator is zero/missing. */
export function percent(numerator: Decimal.Value, denominator: Decimal.Value | null | undefined) {
  if (denominator === null || denominator === undefined) return null
  const d = new Decimal(denominator)
  if (d.isZero()) return null
  return new Decimal(numerator).div(d).mul(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toString()
}

/** Growth from previous to current, as a percentage; null when there is no meaningful base. */
export function growth(current: Decimal.Value, previous: Decimal.Value | null | undefined) {
  if (previous === null || previous === undefined) return null
  const p = new Decimal(previous)
  if (p.isZero()) return null
  return new Decimal(current).sub(p).div(p.abs()).mul(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toString()
}

// ─────────────────────────────────────────────────────────────────────────────
// Profit & Loss
// ─────────────────────────────────────────────────────────────────────────────

export const PNL_SECTIONS = {
  revenue: ["OPERATING_REVENUE"],
  costOfServices: ["COST_OF_SALES"],
  operatingExpenses: ["OPERATING_EXPENSE"],
  depreciation: ["DEPRECIATION"],
  amortization: ["AMORTIZATION"],
  otherIncome: ["OTHER_INCOME", "INTEREST_INCOME"],
  otherExpense: ["OTHER_EXPENSE", "INTEREST_EXPENSE"],
  incomeTax: ["INCOME_TAX"],
} as const

export type PnlSectionKey = keyof typeof PNL_SECTIONS

export type Pnl = {
  sections: Record<PnlSectionKey, Section>
  revenue: string
  costOfServices: string
  grossProfit: string
  operatingExpenses: string
  ebitda: string
  depreciationAndAmortization: string
  ebit: string
  nonOperating: string
  profitBeforeTax: string
  incomeTax: string
  netProfit: string
  totalExpenses: string
  margins: { gross: string | null; ebitda: string | null; ebit: string | null; net: string | null }
}

export function buildPnl(activity: AccountActivity[]): Pnl {
  const sections = {} as Record<PnlSectionKey, Section>
  for (const [key, subtypes] of Object.entries(PNL_SECTIONS) as [PnlSectionKey, readonly string[]][]) {
    const lines = activity
      .filter((a) => (a.type === "REVENUE" || a.type === "EXPENSE") && subtypes.includes(a.subtype))
      .map((a) => {
        // Income lines are positive when earned; expense lines are positive when incurred.
        const income = key === "revenue" || key === "otherIncome"
        const amount = income ? new Decimal(a.credit).sub(a.debit) : new Decimal(a.debit).sub(a.credit)
        return { accountId: a.accountId, code: a.code, name: a.name, amount: amount.toString() }
      })
      .filter((l) => !new Decimal(l.amount).isZero())
      .sort(byCode)
    sections[key] = { key, lines, total: sumOf(lines).toString() }
  }
  const t = (k: PnlSectionKey) => new Decimal(sections[k].total)
  const revenue = t("revenue")
  const grossProfit = revenue.sub(t("costOfServices"))
  const ebitda = grossProfit.sub(t("operatingExpenses"))
  const dna = t("depreciation").add(t("amortization"))
  const ebit = ebitda.sub(dna)
  const nonOperating = t("otherIncome").sub(t("otherExpense"))
  const profitBeforeTax = ebit.add(nonOperating)
  const netProfit = profitBeforeTax.sub(t("incomeTax"))
  const totalExpenses = t("costOfServices").add(t("operatingExpenses")).add(dna).add(t("otherExpense")).add(t("incomeTax"))
  return {
    sections,
    revenue: revenue.toString(),
    costOfServices: t("costOfServices").toString(),
    grossProfit: grossProfit.toString(),
    operatingExpenses: t("operatingExpenses").toString(),
    ebitda: ebitda.toString(),
    depreciationAndAmortization: dna.toString(),
    ebit: ebit.toString(),
    nonOperating: nonOperating.toString(),
    profitBeforeTax: profitBeforeTax.toString(),
    incomeTax: t("incomeTax").toString(),
    netProfit: netProfit.toString(),
    totalExpenses: totalExpenses.toString(),
    margins: { gross: percent(grossProfit, revenue), ebitda: percent(ebitda, revenue), ebit: percent(ebit, revenue), net: percent(netProfit, revenue) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance sheet
// ─────────────────────────────────────────────────────────────────────────────

const BS_GROUPS = {
  cash: { type: "ASSET", subtypes: ["CASH"] },
  receivables: { type: "ASSET", subtypes: ["RECEIVABLE"] },
  prepayments: { type: "ASSET", subtypes: ["PREPAID"] },
  otherCurrentAssets: { type: "ASSET", subtypes: ["OTHER_CURRENT_ASSET"] },
  fixedAssets: { type: "ASSET", subtypes: ["FIXED_ASSET", "ACCUMULATED_DEPRECIATION"] },
  intangibleAssets: { type: "ASSET", subtypes: ["INTANGIBLE_ASSET"] },
  otherNonCurrentAssets: { type: "ASSET", subtypes: ["OTHER_NON_CURRENT_ASSET"] },
  payables: { type: "LIABILITY", subtypes: ["PAYABLE", "ACCRUED_LIABILITY"] },
  payrollPayable: { type: "LIABILITY", subtypes: ["PAYROLL_LIABILITY"] },
  taxLiabilities: { type: "LIABILITY", subtypes: ["TAX_LIABILITY"] },
  shortTermLoans: { type: "LIABILITY", subtypes: ["SHORT_TERM_DEBT"] },
  otherCurrentLiabilities: { type: "LIABILITY", subtypes: ["DEFERRED_REVENUE", "DISTRIBUTIONS_PAYABLE", "OTHER_LIABILITY"] },
  longTermLoans: { type: "LIABILITY", subtypes: ["LONG_TERM_DEBT"] },
  ownerCapital: { type: "EQUITY", subtypes: ["OWNER_CAPITAL"] },
  distributions: { type: "EQUITY", subtypes: ["DISTRIBUTIONS"] },
  retainedEarningsAccount: { type: "EQUITY", subtypes: ["RETAINED_EARNINGS"] },
} as const

export type BalanceGroupKey = keyof typeof BS_GROUPS

export type BalanceSheet = {
  groups: Record<BalanceGroupKey, Section>
  currentAssets: string
  nonCurrentAssets: string
  totalAssets: string
  currentLiabilities: string
  longTermLiabilities: string
  totalLiabilities: string
  ownerCapital: string
  distributions: string
  retainedEarnings: string
  currentPeriodProfit: string
  totalEquity: string
  totalLiabilitiesAndEquity: string
  /** totalAssets - (totalLiabilities + totalEquity); "0" when the books balance. */
  difference: string
  balanced: boolean
}

/**
 * cumulative: balances of every account up to the date. P&L accounts are not closed into retained
 * earnings by entries, so their cumulative result is split: before the fiscal year start goes to
 * retained earnings, from the fiscal year start goes to current period profit.
 */
export function buildBalanceSheet(cumulative: AccountActivity[], currentYearPnl: AccountActivity[]): BalanceSheet {
  const groups = {} as Record<BalanceGroupKey, Section>
  for (const [key, def] of Object.entries(BS_GROUPS) as [BalanceGroupKey, (typeof BS_GROUPS)[BalanceGroupKey]][]) {
    const lines = cumulative
      .filter((a) => a.type === def.type && (def.subtypes as readonly string[]).includes(a.subtype))
      .map((a) => ({ accountId: a.accountId, code: a.code, name: a.name, amount: naturalAmount(a).toString() }))
      .filter((l) => !new Decimal(l.amount).isZero())
      .sort(byCode)
    groups[key] = { key, lines, total: sumOf(lines).toString() }
  }
  const g = (k: BalanceGroupKey) => new Decimal(groups[k].total)
  const allPnl = netIncome(cumulative)
  const currentPeriodProfit = netIncome(currentYearPnl)
  const retainedEarnings = g("retainedEarningsAccount").add(allPnl.sub(currentPeriodProfit))

  const currentAssets = g("cash").add(g("receivables")).add(g("prepayments")).add(g("otherCurrentAssets"))
  const nonCurrentAssets = g("fixedAssets").add(g("intangibleAssets")).add(g("otherNonCurrentAssets"))
  const totalAssets = currentAssets.add(nonCurrentAssets)
  const currentLiabilities = g("payables").add(g("payrollPayable")).add(g("taxLiabilities")).add(g("shortTermLoans")).add(g("otherCurrentLiabilities"))
  const longTermLiabilities = g("longTermLoans")
  const totalLiabilities = currentLiabilities.add(longTermLiabilities)
  // Distributions are a debit-balance equity account: naturalAmount is negative, reducing equity.
  const totalEquity = g("ownerCapital").add(g("distributions")).add(retainedEarnings).add(currentPeriodProfit)
  const difference = totalAssets.sub(totalLiabilities.add(totalEquity))
  return {
    groups,
    currentAssets: currentAssets.toString(),
    nonCurrentAssets: nonCurrentAssets.toString(),
    totalAssets: totalAssets.toString(),
    currentLiabilities: currentLiabilities.toString(),
    longTermLiabilities: longTermLiabilities.toString(),
    totalLiabilities: totalLiabilities.toString(),
    ownerCapital: g("ownerCapital").toString(),
    distributions: g("distributions").toString(),
    retainedEarnings: retainedEarnings.toString(),
    currentPeriodProfit: currentPeriodProfit.toString(),
    totalEquity: totalEquity.toString(),
    totalLiabilitiesAndEquity: totalLiabilities.add(totalEquity).toString(),
    difference: difference.toString(),
    balanced: difference.abs().lte("0.00000001"),
  }
}

/** Revenue minus expenses (net profit) for any set of account activity. */
export function netIncome(activity: AccountActivity[]) {
  return activity
    .filter((a) => a.type === "REVENUE" || a.type === "EXPENSE")
    .reduce((acc, a) => acc.add(new Decimal(a.credit).sub(a.debit)), ZERO)
}

// ─────────────────────────────────────────────────────────────────────────────
// Cash flow (direct method)
// ─────────────────────────────────────────────────────────────────────────────

export type CashLineKey =
  | "clientReceipts"
  | "operatingPayments"
  | "payrollPaid"
  | "taxesPaid"
  | "equipmentPurchases"
  | "assetSales"
  | "investments"
  | "loansReceived"
  | "loanRepayments"
  | "ownerContributions"
  | "ownerDistributions"
  | "otherFinancing"

export const CASH_ACTIVITY: Record<CashLineKey, "operating" | "investing" | "financing"> = {
  clientReceipts: "operating",
  operatingPayments: "operating",
  payrollPaid: "operating",
  taxesPaid: "operating",
  equipmentPurchases: "investing",
  assetSales: "investing",
  investments: "investing",
  loansReceived: "financing",
  loanRepayments: "financing",
  ownerContributions: "financing",
  ownerDistributions: "financing",
  otherFinancing: "financing",
}

export type EntryLine = { accountId: string; type: AccountType; subtype: string; debit: string; credit: string }

/**
 * Classifies the cash effect of a counterpart (non-cash) line by its account. Cash effect = credit - debit
 * of the counterpart: crediting revenue/receivables brings cash in, debiting an expense sends cash out.
 */
export function classifyCashLine(line: Pick<EntryLine, "type" | "subtype">, effect: Decimal): CashLineKey {
  switch (line.subtype) {
    case "RECEIVABLE":
    case "OPERATING_REVENUE":
    case "OTHER_INCOME":
    case "INTEREST_INCOME":
    case "DEFERRED_REVENUE":
      return "clientReceipts"
    case "PAYROLL_LIABILITY":
      return "payrollPaid"
    case "TAX_LIABILITY":
    case "INCOME_TAX":
      return "taxesPaid"
    case "FIXED_ASSET":
    case "INTANGIBLE_ASSET":
    case "ACCUMULATED_DEPRECIATION":
      return effect.isNegative() ? "equipmentPurchases" : "assetSales"
    case "OTHER_NON_CURRENT_ASSET":
      return "investments"
    case "SHORT_TERM_DEBT":
    case "LONG_TERM_DEBT":
      return effect.isNegative() ? "loanRepayments" : "loansReceived"
    case "OWNER_CAPITAL":
      return "ownerContributions"
    case "DISTRIBUTIONS":
    case "DISTRIBUTIONS_PAYABLE":
      return "ownerDistributions"
    case "RETAINED_EARNINGS":
      return "otherFinancing"
    default:
      return "operatingPayments"
  }
}

export type CashFlow = {
  openingCash: string
  lines: Record<CashLineKey, string>
  operating: string
  investing: string
  financing: string
  netChange: string
  closingCash: string
  inflow: string
  outflow: string
  /** Movements between company cash accounts (excluded from the statement; shown for transparency). */
  internalTransfers: string
}

/**
 * entries: every posted journal entry in the period that touches a cash account, with all its lines.
 * isCash: whether an account is a cash account (company bank, cash, wallet, payment provider).
 */
export function buildCashFlow(openingCash: Decimal.Value, entries: { lines: EntryLine[] }[], isCash: (accountId: string) => boolean): CashFlow {
  const lines = Object.fromEntries(Object.keys(CASH_ACTIVITY).map((k) => [k, ZERO])) as Record<CashLineKey, Decimal>
  let inflow = ZERO
  let outflow = ZERO
  let transfers = ZERO
  for (const entry of entries) {
    const cash = entry.lines.filter((l) => isCash(l.accountId))
    const other = entry.lines.filter((l) => !isCash(l.accountId))
    if (cash.length === 0) continue
    if (other.length === 0) {
      // Only company cash accounts: an internal transfer. Net effect is zero by double entry.
      transfers = transfers.add(cash.reduce((acc, l) => acc.add(l.debit), ZERO))
      continue
    }
    for (const line of other) {
      const effect = new Decimal(line.credit).sub(line.debit)
      if (effect.isZero()) continue
      const key = classifyCashLine(line, effect)
      lines[key] = lines[key].add(effect)
      if (effect.isPositive()) inflow = inflow.add(effect)
      else outflow = outflow.add(effect.abs())
    }
  }
  const total = (activity: "operating" | "investing" | "financing") =>
    (Object.keys(lines) as CashLineKey[]).filter((k) => CASH_ACTIVITY[k] === activity).reduce((acc, k) => acc.add(lines[k]), ZERO)
  const operating = total("operating")
  const investing = total("investing")
  const financing = total("financing")
  const netChange = operating.add(investing).add(financing)
  return {
    openingCash: new Decimal(openingCash).toString(),
    lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.toString()])) as Record<CashLineKey, string>,
    operating: operating.toString(),
    investing: investing.toString(),
    financing: financing.toString(),
    netChange: netChange.toString(),
    closingCash: new Decimal(openingCash).add(netChange).toString(),
    inflow: inflow.toString(),
    outflow: outflow.toString(),
    internalTransfers: transfers.toString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner distributions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits an explicitly chosen distributable amount by each holder's share (profit share when set,
 * otherwise ownership). Rounds to cents and gives any rounding remainder to the largest holder, so the
 * allocations always add up to the amount exactly.
 */
export function allocateDistribution(amount: Decimal.Value, holders: { id: string; share: Decimal.Value }[], decimals = 2) {
  const total = new Decimal(amount)
  if (total.lte(0)) throw new Error("Distributable amount must be positive")
  const shareSum = holders.reduce((acc, h) => acc.add(h.share), ZERO)
  if (shareSum.isZero()) throw new Error("No holder has a share")
  if (shareSum.gt(1)) throw new Error("Shares exceed 100%")
  const allocations = holders.map((h) => ({ id: h.id, share: new Decimal(h.share), amount: total.mul(h.share).toDecimalPlaces(decimals, Decimal.ROUND_DOWN) }))
  // Shares below 100% leave the rest undistributed (retained); only the rounding gap is reassigned.
  const target = total.mul(shareSum).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
  const gap = target.sub(allocations.reduce((acc, a) => acc.add(a.amount), ZERO))
  if (!gap.isZero()) {
    const largest = allocations.reduce((max, a) => (a.share.gt(max.share) ? a : max), allocations[0])
    largest.amount = largest.amount.add(gap)
  }
  return {
    allocations: allocations.map((a) => ({ id: a.id, share: a.share.toString(), amount: a.amount.toString() })),
    allocated: target.toString(),
    retained: total.sub(target).toString(),
  }
}
