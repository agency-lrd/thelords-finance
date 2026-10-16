/**
 * Payroll calculation engine. Pure and deterministic: the same inputs always give the same payslip,
 * with exact decimal arithmetic (no floating point). Safe to run on the server and in tests.
 *
 * One employee, one month:
 *   base salary (monthly, fixed fee, or hourly/daily x worked time)
 *   + compensation rules evaluated against the employee's KPI (e.g. 10% of profit above the KPI target)
 *   + approved adjustments (bonuses, corrections, reimbursements)
 *   - deductions
 *   = net payable
 *
 * Every amount is rounded per line to the currency's minor unit, so the payslip lines always add up
 * to the totals shown.
 */
import Decimal from "decimal.js"

export { Decimal }

export type PayBasis = "MONTHLY" | "HOURLY" | "DAILY" | "FIXED_FEE"
export type CompensationType = "KPI_BONUS" | "COMMISSION" | "FIXED_BONUS" | "ALLOWANCE" | "OVERTIME" | "DEDUCTION"
export type CalculationMethod = "FIXED_AMOUNT" | "PERCENT_OF_BASE" | "PERCENT_OF_METRIC" | "TIERED" | "PER_UNIT"
export type MetricBasis = "TOTAL" | "ABOVE_TARGET" | "TOTAL_IF_TARGET_MET"
export type AdjustmentType = "BONUS" | "CORRECTION" | "DEDUCTION" | "REIMBURSEMENT" | "ADVANCE" | "ADVANCE_RECOVERY"
export type LineType =
  | "BASE_SALARY"
  | "KPI_BONUS"
  | "COMMISSION"
  | "BONUS"
  | "ALLOWANCE"
  | "OVERTIME"
  | "REIMBURSEMENT"
  | "DEDUCTION"
  | "ADVANCE_RECOVERY"
  | "ADJUSTMENT"

type Num = Decimal.Value

export type SalaryInput = {
  payBasis: PayBasis
  amount: Num
  workedHours?: Num | null
  workedDays?: Num | null
}

export type RuleTier = { from: Num; to?: Num | null; rate?: Num | null; fixedAmount?: Num | null }

export type RuleInput = {
  id?: string
  name: string
  type: CompensationType
  method: CalculationMethod
  metricBasis?: MetricBasis
  rate?: Num | null
  fixedAmount?: Num | null
  capAmount?: Num | null
  floorAmount?: Num | null
  tiers?: RuleTier[]
}

export type AdjustmentInput = { id?: string; type: AdjustmentType; amount: Num; reason: string }

export type PayrollInput = {
  salary: SalaryInput | null
  /** KPI the rules are measured against (KPI Profit target and KPI Fact). */
  kpi?: { target?: Num | null; actual?: Num | null }
  rules?: RuleInput[]
  adjustments?: AdjustmentInput[]
  /** Signed manual correction entered on the sheet (positive adds, negative subtracts). */
  manualAdjustment?: Num | null
  /** Minor-unit precision of the payslip currency (2 for USD/EUR/GBP). */
  decimals?: number
}

export type PayrollLine = {
  source: "salary" | "rule" | "adjustment" | "manual"
  lineType: LineType
  description: string
  /** Signed: earnings positive, deductions negative. */
  amount: Decimal
  quantity?: Decimal
  rate?: Decimal
  ruleId?: string
  adjustmentId?: string
}

export type PayrollResult = {
  lines: PayrollLine[]
  fixed: Decimal
  variable: Decimal
  bonus: Decimal
  deductions: Decimal
  gross: Decimal
  net: Decimal
  /** Metric the rules used after applying the KPI basis, for display ("profit above KPI"). */
  metric: Decimal
  targetMet: boolean | null
  warnings: string[]
}

const ZERO = new Decimal(0)
const d = (value: Num | null | undefined) => (value === null || value === undefined || value === "" ? null : new Decimal(value))

const RULE_LINE: Record<CompensationType, LineType> = {
  KPI_BONUS: "KPI_BONUS",
  COMMISSION: "COMMISSION",
  FIXED_BONUS: "BONUS",
  ALLOWANCE: "ALLOWANCE",
  OVERTIME: "OVERTIME",
  DEDUCTION: "DEDUCTION",
}

const ADJUSTMENT_LINE: Record<Exclude<AdjustmentType, "ADVANCE">, { lineType: LineType; sign: 1 | -1 }> = {
  BONUS: { lineType: "BONUS", sign: 1 },
  CORRECTION: { lineType: "ADJUSTMENT", sign: 1 },
  REIMBURSEMENT: { lineType: "REIMBURSEMENT", sign: 1 },
  DEDUCTION: { lineType: "DEDUCTION", sign: -1 },
  ADVANCE_RECOVERY: { lineType: "ADVANCE_RECOVERY", sign: -1 },
}

/** Evaluates one rule. Returns the unrounded payout (positive) and the metric it was based on. */
export function evaluateRule(rule: RuleInput, base: Decimal, kpi: PayrollInput["kpi"] = {}) {
  const actual = d(kpi?.actual) ?? ZERO
  const target = d(kpi?.target)
  const basis = rule.metricBasis ?? "TOTAL"
  const targetMet = target === null ? null : actual.gte(target)

  let metric = actual
  let triggered = true
  if (basis === "ABOVE_TARGET") {
    metric = Decimal.max(ZERO, actual.sub(target ?? ZERO))
    triggered = metric.gt(0)
  } else if (basis === "TOTAL_IF_TARGET_MET") {
    triggered = targetMet === true
    if (!triggered) metric = ZERO
  }

  let amount = ZERO
  if (triggered) {
    switch (rule.method) {
      case "FIXED_AMOUNT":
        amount = d(rule.fixedAmount) ?? ZERO
        break
      case "PERCENT_OF_BASE":
        amount = base.mul(d(rule.rate) ?? ZERO)
        break
      case "PERCENT_OF_METRIC":
      case "PER_UNIT":
        amount = metric.mul(d(rule.rate) ?? ZERO)
        break
      case "TIERED": {
        const tier = (rule.tiers ?? []).find((t) => metric.gte(t.from) && (d(t.to) === null || metric.lt(t.to as Num)))
        if (tier) amount = d(tier.fixedAmount) ?? metric.mul(d(tier.rate) ?? ZERO)
        break
      }
    }
  }

  const floor = d(rule.floorAmount)
  const cap = d(rule.capAmount)
  if (amount.gt(0) && floor && amount.lt(floor)) amount = floor
  if (cap && amount.gt(cap)) amount = cap
  return { amount: Decimal.max(ZERO, amount), metric, targetMet, rate: d(rule.rate) }
}

export function calculatePayroll(input: PayrollInput): PayrollResult {
  const decimals = input.decimals ?? 2
  const round = (value: Decimal) => value.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
  const lines: PayrollLine[] = []
  const warnings: string[] = []

  // Base salary
  let base = ZERO
  const salary = input.salary
  if (!salary) {
    warnings.push("No salary agreement for this month.")
  } else {
    const amount = new Decimal(salary.amount)
    if (salary.payBasis === "MONTHLY" || salary.payBasis === "FIXED_FEE") {
      base = round(amount)
      lines.push({ source: "salary", lineType: "BASE_SALARY", description: salary.payBasis === "FIXED_FEE" ? "Fixed fee" : "Base salary", amount: base })
    } else {
      const quantity = d(salary.payBasis === "HOURLY" ? salary.workedHours : salary.workedDays)
      if (quantity === null) {
        warnings.push(salary.payBasis === "HOURLY" ? "Worked hours not entered." : "Worked days not entered.")
      } else {
        base = round(amount.mul(quantity))
        lines.push({
          source: "salary",
          lineType: "BASE_SALARY",
          description: salary.payBasis === "HOURLY" ? "Hourly pay" : "Daily pay",
          amount: base,
          quantity,
          rate: amount,
        })
      }
    }
  }

  // Compensation rules
  const kpi = input.kpi ?? {}
  let metric = d(kpi.actual) ?? ZERO
  let targetMet: boolean | null = null
  for (const rule of input.rules ?? []) {
    if ((rule.metricBasis ?? "TOTAL") !== "TOTAL" && d(kpi.target) === null) {
      warnings.push(`${rule.name}: KPI target not set; the whole KPI fact is used.`)
    }
    const result = evaluateRule(rule, base, kpi)
    metric = result.metric
    targetMet = result.targetMet
    const amount = round(result.amount)
    if (amount.isZero()) continue
    const lineType = RULE_LINE[rule.type]
    lines.push({
      source: "rule",
      lineType,
      description: rule.name,
      amount: lineType === "DEDUCTION" ? amount.neg() : amount,
      quantity: rule.method === "PERCENT_OF_BASE" ? base : result.metric,
      rate: result.rate ?? undefined,
      ruleId: rule.id,
    })
  }

  // Approved adjustments
  for (const adjustment of input.adjustments ?? []) {
    if (adjustment.type === "ADVANCE") {
      warnings.push("Salary advances are paid separately and are not part of the monthly payslip.")
      continue
    }
    const { lineType, sign } = ADJUSTMENT_LINE[adjustment.type]
    const amount = round(new Decimal(adjustment.amount).abs())
    if (amount.isZero()) continue
    lines.push({ source: "adjustment", lineType, description: adjustment.reason, amount: sign === 1 ? amount : amount.neg(), adjustmentId: adjustment.id })
  }

  const manual = d(input.manualAdjustment)
  if (manual && !manual.isZero()) {
    lines.push({ source: "manual", lineType: "ADJUSTMENT", description: "Manual adjustment", amount: round(manual) })
  }

  const sum = (filter: (line: PayrollLine) => boolean) => lines.filter(filter).reduce((acc, l) => acc.add(l.amount), ZERO)
  const fixed = sum((l) => l.source === "salary")
  const variable = sum((l) => l.source === "rule" && l.amount.gt(0))
  const bonus = sum((l) => (l.source === "adjustment" || l.source === "manual") && l.amount.gt(0))
  const gross = sum((l) => l.amount.gt(0))
  const deductions = sum((l) => l.amount.lt(0)).abs()
  const net = gross.sub(deductions)
  if (net.lt(0)) warnings.push("Deductions exceed earnings.")

  return { lines, fixed, variable, bonus, deductions, gross, net, metric, targetMet, warnings }
}

/** Human description of a rule, used for the sheet's "Add Terms" column. */
export function describeRule(rule: Pick<RuleInput, "method" | "metricBasis" | "rate" | "fixedAmount" | "capAmount" | "tiers">, locale: "ru" | "en" = "ru") {
  const pct = (value: Num | null | undefined) => `${new Decimal(value ?? 0).mul(100).toDecimalPlaces(2).toString()}%`
  const ru = locale === "ru"
  const basis = rule.metricBasis ?? "TOTAL"
  const of =
    basis === "ABOVE_TARGET"
      ? ru ? "от профита после KPI" : "of profit above KPI"
      : basis === "TOTAL_IF_TARGET_MET"
        ? ru ? "от профита при выполнении KPI" : "of profit if KPI met"
        : ru ? "от профита" : "of profit"
  let text: string
  switch (rule.method) {
    case "PERCENT_OF_METRIC":
    case "PER_UNIT":
      text = `${pct(rule.rate)} ${of}`
      break
    case "PERCENT_OF_BASE":
      text = ru ? `${pct(rule.rate)} от оклада` : `${pct(rule.rate)} of base`
      break
    case "FIXED_AMOUNT":
      text =
        basis === "TOTAL_IF_TARGET_MET"
          ? ru ? `Бонус $${new Decimal(rule.fixedAmount ?? 0).toString()} при выполнении KPI` : `$${new Decimal(rule.fixedAmount ?? 0).toString()} bonus if KPI met`
          : ru ? `Фикс. бонус $${new Decimal(rule.fixedAmount ?? 0).toString()}` : `Fixed bonus $${new Decimal(rule.fixedAmount ?? 0).toString()}`
      break
    case "TIERED":
      text = ru ? `Ступенчатая комиссия (${rule.tiers?.length ?? 0} ступ.)` : `Tiered commission (${rule.tiers?.length ?? 0} tiers)`
      break
  }
  if (rule.capAmount) text += ru ? `, макс. $${new Decimal(rule.capAmount).toString()}` : `, cap $${new Decimal(rule.capAmount).toString()}`
  return text
}
