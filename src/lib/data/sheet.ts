import "server-only"

import { Prisma, type CalculationMethod, type CompensationType, type EmployeeStatus, type MetricBasis } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { decryptSecret, detectNetwork, encryptSecret, maskIdentifier } from "@/lib/crypto/wallet"
import { UserInputError } from "@/lib/forms"
import { Decimal, toBase } from "@/lib/money"
import { calculatePayroll, describeRule, type PayrollResult, type RuleInput } from "@/lib/payroll/engine"
import { monthEnd, monthLabel, monthStart, type Month } from "@/lib/period"

import { assertPeriodOpen, audit, ensurePeriod, fxRateFor, type Tx } from "./common"
import { inTx, prisma, type Db } from "./db"
import { accountByCode, postJournal } from "./ledger"

/*
 * The financial sheet: one row per employee per month, recreating the team's spreadsheet.
 *
 * Every number on a row comes from a source record, so the sheet is a live calculation:
 *   FIX          salary agreement in force that month (effective-dated; edits start from the month)
 *   Add Terms    the employee's compensation rule (versioned; edits start from the month)
 *   KPI Profit   KPI target (Profit) for the month;  KPI Fact: KPI actual
 *   Bonus        approved bonus adjustments;          Deductions: approved deduction adjustments
 *   Payable      calculated by the payroll engine
 * Confirming a row snapshots the calculation into a payslip (payroll item + lines). Approving the month
 * locks every payslip and posts the payroll accrual to the ledger. Payments are recorded against
 * approved payslips and posted to the ledger too.
 */

const PROFIT_KPI = "PROFIT"

export type RuleModel = "NONE" | "PCT_ABOVE_KPI" | "PCT_OF_PROFIT" | "PCT_IF_KPI_MET" | "BONUS_IF_KPI_MET" | "PCT_OF_BASE" | "TIERED"

export type RuleConfig = {
  model: RuleModel
  /** Percent as entered (10 = 10%). */
  ratePct?: string | null
  fixedAmount?: string | null
  capAmount?: string | null
  tiers?: { from: string; to?: string | null; ratePct: string }[]
}

const MODEL_MAP: Record<Exclude<RuleModel, "NONE">, { type: CompensationType; method: CalculationMethod; basis: MetricBasis; usesKpi: boolean }> = {
  PCT_ABOVE_KPI: { type: "COMMISSION", method: "PERCENT_OF_METRIC", basis: "ABOVE_TARGET", usesKpi: true },
  PCT_OF_PROFIT: { type: "COMMISSION", method: "PERCENT_OF_METRIC", basis: "TOTAL", usesKpi: true },
  PCT_IF_KPI_MET: { type: "KPI_BONUS", method: "PERCENT_OF_METRIC", basis: "TOTAL_IF_TARGET_MET", usesKpi: true },
  BONUS_IF_KPI_MET: { type: "KPI_BONUS", method: "FIXED_AMOUNT", basis: "TOTAL_IF_TARGET_MET", usesKpi: true },
  PCT_OF_BASE: { type: "FIXED_BONUS", method: "PERCENT_OF_BASE", basis: "TOTAL", usesKpi: false },
  TIERED: { type: "COMMISSION", method: "TIERED", basis: "TOTAL", usesKpi: true },
}

function modelOf(rule: { method: CalculationMethod; metricBasis: MetricBasis }): RuleModel {
  for (const [model, m] of Object.entries(MODEL_MAP)) {
    if (m.method === rule.method && m.basis === rule.metricBasis) return model as RuleModel
  }
  return "PCT_OF_PROFIT"
}

const overlapsMonth = (m: Month) => ({ validFrom: { lte: monthEnd(m) }, OR: [{ validTo: null }, { validTo: { gt: monthStart(m) } }] })

/**
 * The KPI target that applies to a month: the month's own target, otherwise the latest earlier target
 * marked recurring. The sheet and the confirmation snapshot both use this, so they always agree.
 */
const targetForMonth = (kpiDefinitionId: string, m: Month) => ({
  where: { kpiDefinitionId, OR: [{ period: { year: m.year, month: m.month } }, { recurring: true, period: { startDate: { lt: monthStart(m) } } }] },
  orderBy: { period: { startDate: "desc" as const } },
  take: 1,
  include: { period: { select: { year: true, month: true } } },
})
const str = (value: Prisma.Decimal | Decimal | null | undefined) => (value === null || value === undefined ? null : new Decimal(value).toString())

/** What an approved month froze for one employee (shown instead of live values from then on). */
export type MonthSnapshot = {
  name: string
  firstName: string
  lastName: string
  employeeNumber: string
  isTeamLead: boolean
  status: string
  notes: string | null
  terminationDate: string | null
  salaryApproved: boolean
  kpiTargetRecurring: boolean
  payBasis: string
  departmentId: string | null
  departmentName: string | null
  position: string | null
  hireDate: string
  fix: string | null
  currency: string
  terms: string | null
  rule: RuleConfig
  kpiTarget: string | null
  kpiActual: string | null
  kpiTargetInherited: boolean
  variable: string
  bonus: string
  deduction: string
  calculated: string
}

const SNAPSHOT_KEYS: (keyof MonthSnapshot)[] = ["firstName", "lastName", "employeeNumber", "isTeamLead", "status", "notes", "terminationDate", "salaryApproved", "kpiTargetRecurring", "payBasis", "name", "departmentId", "departmentName", "position", "hireDate", "fix", "currency", "terms", "rule", "kpiTarget", "kpiActual", "kpiTargetInherited", "variable", "bonus", "deduction", "calculated"]

function pickSnapshot(source: MonthSnapshot): MonthSnapshot {
  return Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, source[k]])) as MonthSnapshot
}

async function profitKpi(db: Db | Tx, organizationId: string) {
  const kpi = await db.kpiDefinition.findUnique({ where: { organizationId_code: { organizationId, code: PROFIT_KPI } } })
  if (!kpi) throw new UserInputError("The Profit KPI is missing. Run the latest database migration.")
  return kpi
}

async function findRun(db: Db | Tx, organizationId: string, m: Month) {
  return db.payrollRun.findFirst({
    where: { organizationId, runType: "REGULAR", sequence: 1, period: { year: m.year, month: m.month } },
    include: { period: true, approvals: { include: { approver: { select: { email: true } } }, orderBy: { decidedAt: "asc" } } },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the sheet
// ─────────────────────────────────────────────────────────────────────────────

export type SheetRow = Awaited<ReturnType<typeof getSheet>>["rows"][number]

export async function getSheet(user: SessionUser, m: Month, db: Db = prisma, options: { employeeId?: string } = {}) {
  // Sequential on purpose: db may be a transaction, which runs one query at a time.
  const kpi = await profitKpi(db, user.organizationId)
  const run = await findRun(db, user.organizationId, m)
  const period = await db.financialPeriod.findUnique({
    where: { organizationId_year_month: { organizationId: user.organizationId, year: m.year, month: m.month } },
  })

  const employees = await db.employee.findMany({
    where: {
      organizationId: user.organizationId,
      ...(options.employeeId ? { id: options.employeeId } : {}),
      // The month's roster: employees added in this month or carried over from the approved previous month.
      monthMemberships: { some: { period: { year: m.year, month: m.month } } },
      // Archived employees leave draft months; a month where they have a payslip keeps showing them.
      OR: [{ archivedAt: null }, ...(run ? [{ payrollItems: { some: { payrollRunId: run.id } } }] : [])],
    },
    include: {
      assignments: { where: { isPrimary: true, ...overlapsMonth(m) }, include: { department: true }, orderBy: { validFrom: "desc" }, take: 1 },
      salaryConditions: { where: overlapsMonth(m), orderBy: { validFrom: "desc" }, take: 1 },
      compensationScopes: {
        where: overlapsMonth(m),
        include: { rule: { include: { tiers: { orderBy: { sortOrder: "asc" } } } } },
        orderBy: { validFrom: "desc" },
      },
      kpiTargets: targetForMonth(kpi.id, m),
      kpiActuals: { where: { kpiDefinitionId: kpi.id, period: { year: m.year, month: m.month } } },
      payrollAdjustments: { where: { period: { year: m.year, month: m.month }, status: { in: ["PENDING", "APPROVED", "APPLIED"] } } },
      payoutWallets: { where: { archivedAt: null }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], take: 1 },
      monthMemberships: { where: { period: { year: m.year, month: m.month } }, take: 1, select: { source: true, snapshot: true, snapshotAt: true } },
      payrollItems: run
        ? { where: { payrollRunId: run.id }, include: { payments: { where: { status: { in: ["SENT", "CONFIRMED"] } } }, lines: true } }
        : { where: { id: "00000000-0000-0000-0000-000000000000" }, include: { payments: true, lines: true } },
    },
  })

  const rows = employees.map((e) => {
    const salary = e.salaryConditions[0] ?? null
    const assignment = e.assignments[0] ?? null
    const rules = e.compensationScopes.map((s) => s.rule)
    const targetRecord = e.kpiTargets[0] ?? null
    const target = targetRecord?.targetValue ?? null
    const targetInherited = !!targetRecord && (targetRecord.period.year !== m.year || targetRecord.period.month !== m.month)
    const actual = e.kpiActuals[0]?.actualValue ?? null
    const approvedAdjustments = e.payrollAdjustments.filter((a) => a.status !== "PENDING")
    const pending = e.payrollAdjustments.filter((a) => a.status === "PENDING")
    const calc = calculate(salary, rules, target, actual, approvedAdjustments)

    const item = e.payrollItems[0] ?? null
    const confirmed = !!item?.confirmedAt
    const paidBase = (item?.payments ?? []).reduce((acc, p) => acc.add(new Decimal(p.baseAmount)), new Decimal(0))
    const itemFx = item ? new Decimal(item.fxRateToBase) : null
    const approvedNet = item ? new Decimal(item.netAmount) : null
    const paid = item && itemFx ? paidBase.div(itemFx).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : new Decimal(0)
    const outstanding = approvedNet ? Decimal.max(new Decimal(0), approvedNet.sub(paid)) : null
    const lastPayment = (item?.payments ?? []).map((p) => p.paidAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    const stale = confirmed && approvedNet !== null && !approvedNet.eq(calc.net)

    const bonus = sumAdjustments(e.payrollAdjustments, ["BONUS", "CORRECTION", "REIMBURSEMENT"])
    const deduction = sumAdjustments(e.payrollAdjustments, ["DEDUCTION", "ADVANCE_RECOVERY"])
    const wallet = e.payoutWallets[0] ?? null

    return {
      employeeId: e.id,
      employeeNumber: e.employeeNumber,
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      firstName: e.firstName,
      lastName: e.lastName,
      isTeamLead: e.isTeamLead,
      status: e.status,
      archived: !!e.archivedAt,
      position: e.jobTitle,
      notes: e.notes,
      hireDate: e.hireDate.toISOString().slice(0, 10),
      departmentId: assignment?.departmentId ?? null,
      departmentName: assignment?.department.name ?? null,
      currency: salary?.currency ?? user.baseCurrency,
      payBasis: salary?.payBasis ?? "MONTHLY",
      fix: str(salary?.baseAmount),
      salaryApproved: !salary || !!salary.approvedById,
      terms: rules.map((r) => describeRule(ruleInput(r))).join(" + ") || null,
      rule: rules[0] ? ruleConfigOf(rules[0]) : ({ model: "NONE" } as RuleConfig),
      kpiTarget: str(target),
      /** The target comes from an earlier month (recurring), not set for this month. */
      kpiTargetInherited: targetInherited,
      kpiTargetRecurring: targetRecord?.recurring ?? false,
      terminationDate: e.terminationDate ? e.terminationDate.toISOString().slice(0, 10) : null,
      /** How the employee got onto this month's sheet (new, carried over, or from before rosters existed). */
      monthSource: e.monthMemberships[0]?.source ?? null,
      kpiActual: str(actual),
      variable: calc.variable.toString(),
      bonus: bonus.toString(),
      deduction: deduction.toString(),
      pendingAdjustments: pending.length,
      calculated: calc.net.toString(),
      warnings: calc.warnings,
      confirmed,
      stale,
      approved: approvedNet?.toString() ?? null,
      paid: paid.toString(),
      outstanding: outstanding?.toString() ?? null,
      paymentStatus: !item ? "NONE" : paid.isZero() ? "UNPAID" : outstanding?.isZero() ? "PAID" : "PARTIAL",
      paymentDate: lastPayment ? lastPayment.toISOString().slice(0, 10) : null,
      payrollItemId: item?.id ?? null,
      wallet: wallet ? { id: wallet.id, masked: wallet.maskedIdentifier, network: wallet.network, currency: wallet.currency } : null,
    }
  })

  // Approved months show their frozen snapshot (names, departments, terms and amounts as approved),
  // never today's employee profile.
  const frozen = run && !["DRAFT", "CALCULATED"].includes(run.status)
  // The frozen assignment is a department id: a department renamed later shows its current name.
  const departmentNames = frozen ? new Map((await db.department.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true } })).map((d) => [d.id, d.name])) : new Map<string, string>()
  for (const [i, r] of rows.entries()) {
    const member = employees.find((e) => e.id === r.employeeId)?.monthMemberships[0]
    const snap = frozen ? (member?.snapshot as MonthSnapshot | null) : null
    if (snap) rows[i] = { ...r, ...(pickSnapshot(snap) as unknown as Partial<typeof r>), departmentName: ((snap.departmentId && departmentNames.get(snap.departmentId)) || snap.departmentName) as typeof r.departmentName, stale: false }
  }

  rows.sort((a, b) => (a.departmentName ?? "~").localeCompare(b.departmentName ?? "~") || Number(b.isTeamLead) - Number(a.isTeamLead) || a.name.localeCompare(b.name))

  const editable =
    (!run || run.status === "DRAFT" || run.status === "CALCULATED") &&
    period?.status !== "CLOSED" &&
    period?.status !== "LOCKED" &&
    (period?.status !== "CLOSING" || user.permissions.has("period:close"))
  return {
    month: m,
    run: run ? { id: run.id, status: run.status, approvals: run.approvals.map((a) => ({ email: a.approver.email, decision: a.decision, at: a.decidedAt.toISOString() })) } : null,
    periodStatus: period?.status ?? "OPEN",
    editable,
    rows,
  }
}

function sumAdjustments(adjustments: { type: string; status: string; amount: Prisma.Decimal }[], types: string[]) {
  return adjustments
    .filter((a) => types.includes(a.type) && a.status !== "PENDING")
    .reduce((acc, a) => acc.add(new Decimal(a.amount)), new Decimal(0))
}

type RuleRow = Prisma.CompensationRuleGetPayload<{ include: { tiers: true } }>

function ruleInput(rule: RuleRow): RuleInput {
  return {
    id: rule.id,
    name: describeRule({ method: rule.method, metricBasis: rule.metricBasis, rate: str(rule.rate), fixedAmount: str(rule.fixedAmount), capAmount: str(rule.capAmount), tiers: rule.tiers.map((t) => ({ from: t.fromValue.toString() })) }),
    type: rule.type,
    method: rule.method,
    metricBasis: rule.metricBasis,
    rate: str(rule.rate),
    fixedAmount: str(rule.fixedAmount),
    capAmount: str(rule.capAmount),
    floorAmount: str(rule.floorAmount),
    tiers: rule.tiers.map((t) => ({ from: t.fromValue.toString(), to: str(t.toValue), rate: str(t.rate), fixedAmount: str(t.fixedAmount) })),
  }
}

function ruleConfigOf(rule: RuleRow): RuleConfig {
  const pct = (v: Prisma.Decimal | null) => (v === null ? null : new Decimal(v).mul(100).toString())
  return {
    model: modelOf(rule),
    ratePct: pct(rule.rate),
    fixedAmount: str(rule.fixedAmount),
    capAmount: str(rule.capAmount),
    tiers: rule.tiers.map((t) => ({ from: t.fromValue.toString(), to: str(t.toValue), ratePct: pct(t.rate) ?? "0" })),
  }
}

function calculate(
  salary: { payBasis: "MONTHLY" | "HOURLY" | "DAILY" | "FIXED_FEE"; baseAmount: Prisma.Decimal } | null,
  rules: RuleRow[],
  target: Prisma.Decimal | null,
  actual: Prisma.Decimal | null,
  adjustments: { id: string; type: "BONUS" | "CORRECTION" | "DEDUCTION" | "REIMBURSEMENT" | "ADVANCE" | "ADVANCE_RECOVERY"; amount: Prisma.Decimal; reason: string }[],
): PayrollResult {
  return calculatePayroll({
    salary: salary ? { payBasis: salary.payBasis, amount: salary.baseAmount.toString() } : null,
    kpi: { target: str(target), actual: str(actual) },
    rules: rules.map(ruleInput),
    adjustments: adjustments.map((a) => ({ id: a.id, type: a.type, amount: a.amount.toString(), reason: a.reason })),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing cells
// ─────────────────────────────────────────────────────────────────────────────

export type SheetField =
  | "name"
  | "fix"
  | "currency"
  | "kpiTarget"
  | "kpiActual"
  | "bonus"
  | "deduction"
  | "department"
  | "position"
  | "status"
  | "isTeamLead"
  | "notes"
  | "hireDate"
  | "wallet"

const FIELD_PERMISSION = {
  name: "employee:manage",
  position: "employee:manage",
  status: "employee:manage",
  isTeamLead: "employee:manage",
  notes: "employee:manage",
  hireDate: "employee:manage",
  department: "employee:manage",
  fix: "salary:manage",
  currency: "salary:manage",
  kpiTarget: "kpi:manage",
  kpiActual: "kpi:manage",
  bonus: "adjustment:request",
  deduction: "adjustment:request",
  wallet: "wallet:manage",
} as const satisfies Record<SheetField, string>

/** Fields whose change alters pay: a confirmed row is un-confirmed so it is re-checked. */
const MONEY_FIELDS: SheetField[] = ["fix", "currency", "kpiTarget", "kpiActual", "bonus", "deduction", "department"]

const AMOUNT = /^-?\d{1,16}(\.\d{1,8})?$/

function parseCellAmount(raw: string, field: string, { allowEmpty = true, allowNegative = false } = {}) {
  const value = raw.trim().replace(/[\s,$€£]/g, "").replace(/USDT$/i, "")
  if (!value) {
    if (allowEmpty) return null
    throw new UserInputError(`${field}: enter an amount.`)
  }
  if (!AMOUNT.test(value)) throw new UserInputError(`${field}: "${raw}" is not a number.`)
  const amount = new Decimal(value)
  if (amount.isNegative() && !allowNegative) throw new UserInputError(`${field} cannot be negative.`)
  return amount
}

export function requiredPermission(field: SheetField) {
  return FIELD_PERMISSION[field]
}

async function editableMonth(tx: Tx, user: SessionUser, m: Month) {
  const period = await ensurePeriod(tx, user.organizationId, m)
  assertPeriodOpen(period, m, user)
  const run = await findRun(tx, user.organizationId, m)
  if (run && run.status !== "DRAFT" && run.status !== "CALCULATED") {
    throw new UserInputError(`${monthLabel(m)} is approved; its sheet can no longer be changed.`)
  }
  return { period, run }
}

/** Removes the employee's confirmed payslip for the month (only possible before approval). */
async function unconfirm(tx: Tx, runId: string | undefined, employeeId: string) {
  if (!runId) return false
  const item = await tx.payrollItem.findUnique({ where: { payrollRunId_employeeId: { payrollRunId: runId, employeeId } } })
  if (!item) return false
  await tx.payrollItemLine.deleteMany({ where: { payrollItemId: item.id } })
  await tx.payrollItem.delete({ where: { id: item.id } })
  return true
}

/** A cell changed since the user loaded it: the edit is refused instead of overwriting it. */
export class SheetConflictError extends UserInputError {
  constructor(public current: string) {
    super("This cell was changed by someone else. The sheet has been refreshed: check the new value and edit again.")
  }
}

/** The value of a cell as the sheet shows it, for conflict checks. */
export function cellValue(row: SheetRow, field: SheetField): string {
  switch (field) {
    case "name": return row.name
    case "department": return row.departmentId ?? ""
    case "fix": return row.fix ?? ""
    case "currency": return row.currency
    case "kpiTarget": return row.kpiTarget ?? ""
    case "kpiActual": return row.kpiActual ?? ""
    case "bonus": return row.bonus
    case "deduction": return row.deduction
    case "position": return row.position ?? ""
    case "status": return row.status
    case "isTeamLead": return String(row.isTeamLead)
    case "notes": return row.notes ?? ""
    case "hireDate": return row.hireDate
    case "wallet": return row.wallet?.masked ?? ""
  }
}

const NUMERIC: SheetField[] = ["fix", "kpiTarget", "kpiActual", "bonus", "deduction"]

function sameValue(field: SheetField, a: string, b: string) {
  if (NUMERIC.includes(field)) {
    const n = (v: string) => (v.trim() === "" ? (field === "bonus" || field === "deduction" ? "0" : "") : v.trim().replace(/[\s,]/g, ""))
    const x = n(a)
    const y = n(b)
    if (x === "" || y === "") return x === y
    return /^-?\d+(\.\d+)?$/.test(x) && /^-?\d+(\.\d+)?$/.test(y) ? new Decimal(x).eq(y) : x === y
  }
  if (field === "isTeamLead") return /^(true|1)$/i.test(a.trim()) === /^(true|1)$/i.test(b.trim())
  return a.trim() === b.trim()
}

/**
 * Edits one cell. `expected` is the value the user saw when they started editing: if the cell has
 * changed since (another user, another tab), the edit is refused with SheetConflictError instead of
 * silently overwriting it. The employee row is locked for the duration, so concurrent edits queue.
 */
export async function updateSheetCell(user: SessionUser, m: Month, employeeId: string, field: SheetField, raw: string, db: Db = prisma, expected?: string | null, scope?: ChangeScope) {
  if (!user.permissions.has(FIELD_PERMISSION[field])) throw new UserInputError("You do not have permission to edit this column.")
  return inTx(db, async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId: user.organizationId } })
    if (!employee) throw new UserInputError("Employee not found.")
    await tx.$executeRaw`SELECT 1 FROM employees WHERE id = ${employeeId}::uuid FOR UPDATE`
    const { period, run } = await editableMonth(tx, user, m)
    if (!(await tx.payrollMonthEmployee.findUnique({ where: { periodId_employeeId: { periodId: period.id, employeeId } } }))) {
      throw new UserInputError("The employee is not on this month's sheet. Carry them over from the previous month or add them first.")
    }
    const value = raw.trim()
    if (expected !== undefined && expected !== null) {
      const current = (await getSheet(user, m, tx, { employeeId })).rows[0]
      if (current && !sameValue(field, cellValue(current, field), expected)) throw new SheetConflictError(cellValue(current, field))
    }

    switch (field) {
      case "name": {
        if (!value) throw new UserInputError("Name is required.")
        if (value.length > 160) throw new UserInputError("Name is too long.")
        const [first, ...rest] = value.split(/\s+/)
        await tx.employee.update({ where: { id: employeeId }, data: { firstName: first, lastName: rest.join(" ") } })
        break
      }
      case "position":
        await tx.employee.update({ where: { id: employeeId }, data: { jobTitle: value.slice(0, 120) || null } })
        break
      case "notes":
        await tx.employee.update({ where: { id: employeeId }, data: { notes: value.slice(0, 2000) || null } })
        break
      case "isTeamLead":
        await tx.employee.update({ where: { id: employeeId }, data: { isTeamLead: value === "true" } })
        break
      case "status": {
        const statuses: EmployeeStatus[] = ["ONBOARDING", "ACTIVE", "ON_LEAVE", "TERMINATED"]
        if (!statuses.includes(value as EmployeeStatus)) throw new UserInputError("Choose a valid status.")
        await tx.employee.update({
          where: { id: employeeId },
          data: {
            status: value as EmployeeStatus,
            terminationDate: value === "TERMINATED" ? (employee.terminationDate ?? monthEnd(m)) : null,
          },
        })
        break
      }
      case "hireDate": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UserInputError("Start date must be YYYY-MM-DD.")
        await tx.employee.update({ where: { id: employeeId }, data: { hireDate: new Date(`${value}T00:00:00Z`) } })
        break
      }
      case "department":
        await setDepartmentFrom(tx, user, employeeId, value, monthStart(m))
        break
      case "fix":
      case "currency":
        await setSalaryFrom(tx, user, employee, m, field === "fix" ? { amount: parseCellAmount(value, "FIX", { allowEmpty: false }) } : { currency: value }, scope)
        break
      case "kpiTarget":
      case "kpiActual":
        await setKpi(tx, user, employeeId, period.id, field, parseCellAmount(value, field === "kpiTarget" ? "KPI Profit" : "KPI Fact", { allowNegative: field === "kpiActual" }), field === "kpiTarget" && scope ? scope === "future" : undefined)
        break
      case "bonus":
      case "deduction":
        await setSheetAdjustment(tx, user, employeeId, period.id, field === "bonus" ? "BONUS" : "DEDUCTION", parseCellAmount(value, field === "bonus" ? "Bonus" : "Deduction"), m)
        break
      case "wallet":
        await setWallet(tx, user, employeeId, value)
        break
    }

    // A confirmed row needs confirming again only if its result changed (department and currency are
    // part of the payslip snapshot, so they always do).
    let unconfirmed = false
    if (MONEY_FIELDS.includes(field)) {
      const after = (await getSheet(user, m, tx, { employeeId })).rows[0]
      const unchanged = after?.approved != null && field !== "department" && field !== "currency" && new Decimal(after.calculated).eq(after.approved)
      if (!unchanged) unconfirmed = await unconfirm(tx, run?.id, employeeId)
    }
    await audit(tx, user, `sheet.update.${field}`, "employee", employeeId, {
      month: `${m.year}-${String(m.month).padStart(2, "0")}`,
      // Wallet details are never written to the audit log.
      value: field === "wallet" ? (value ? maskIdentifier(value) : null) : value,
      unconfirmed,
    })
    return { unconfirmed }
  })
}

/** Effective-dated salary: the change applies from the month's first day until the next recorded change. */
export type ChangeScope = "month" | "future"

/**
 * Effective-dated salary change from the month's first day.
 *  - "future" (default): applies until the next recorded change;
 *  - "month": applies to this month only; the previous terms continue from the next month.
 * A change never reaches into a later month whose payroll is already approved: it stops there and the
 * terms that month was approved with continue, so approved history is never rewritten.
 */
async function setSalaryFrom(
  tx: Tx,
  user: SessionUser,
  employee: { id: string },
  m: Month,
  change: { amount?: Decimal | null; currency?: string },
  scope: ChangeScope = "future",
) {
  const start = monthStart(m)
  if (change.currency && !["USD", "EUR", "GBP", "USDT"].includes(change.currency)) throw new UserInputError("Choose a supported currency.")
  const current = await tx.salaryCondition.findFirst({
    where: { employeeId: employee.id, validFrom: { lte: start }, OR: [{ validTo: null }, { validTo: { gt: start } }] },
  })
  const next = await tx.salaryCondition.findFirst({ where: { employeeId: employee.id, validFrom: { gt: start } }, orderBy: { validFrom: "asc" } })
  const approved = user.permissions.has("salary:approve")
  const amount = change.amount ?? (current ? new Decimal(current.baseAmount) : null)
  if (amount === null) throw new UserInputError("Enter FIX first.")
  const currency = change.currency ?? current?.currency ?? user.baseCurrency

  // Where the current terms end today, and where the new terms must stop.
  const oldEnd = current ? (current.validTo ?? next?.validFrom ?? null) : (next?.validFrom ?? null)
  const lockedRun = await tx.payrollRun.findFirst({
    where: { organizationId: user.organizationId, status: { in: ["SUBMITTED", "APPROVED", "PAYING", "PAID"] }, period: { startDate: { gt: start } } },
    orderBy: { period: { startDate: "asc" } },
    select: { period: { select: { startDate: true } } },
  })
  let newEnd = oldEnd
  const cap = scope === "month" ? new Date(Date.UTC(m.year, m.month, 1)) : (lockedRun?.period.startDate ?? null)
  if (cap && (newEnd === null || cap < newEnd)) newEnd = cap
  const sameTerms = current && new Decimal(current.baseAmount).eq(amount) && current.currency === currency
  if (sameTerms) return

  const terms = { payBasis: current?.payBasis ?? ("MONTHLY" as const), standardHoursPerMonth: current?.standardHoursPerMonth }
  const approval = { approvedById: approved ? user.id : null, approvedAt: approved ? new Date() : null }
  const continueOld = current && newEnd !== null && (oldEnd === null || newEnd < oldEnd)

  if (current && current.validFrom.getTime() === start.getTime()) {
    if (!continueOld) {
      // The record starts this month and keeps its end: correct it in place.
      await tx.salaryCondition.update({ where: { id: current.id }, data: { baseAmount: amount.toString(), currency, ...approval, changeReason: "Changed on the financial sheet" } })
      return
    }
    // Keep the old terms after this change: move the record's start, then add the new terms before it.
    await tx.salaryCondition.update({ where: { id: current.id }, data: { validFrom: newEnd! } })
  } else if (current) {
    await tx.salaryCondition.update({ where: { id: current.id }, data: { validTo: start } })
    if (continueOld) {
      await tx.salaryCondition.create({
        data: { employeeId: employee.id, ...terms, baseAmount: current.baseAmount, currency: current.currency, validFrom: newEnd!, validTo: oldEnd, changeReason: `Continues after the ${monthLabel(m)} change`, approvedById: current.approvedById, approvedAt: current.approvedAt },
      })
    }
  }
  await tx.salaryCondition.create({
    data: {
      employeeId: employee.id,
      ...terms,
      baseAmount: amount.toString(),
      currency,
      validFrom: start,
      validTo: newEnd,
      changeReason: current ? `Changed on the financial sheet from ${monthLabel(m)}${scope === "month" ? " (this month only)" : ""}` : "Set on the financial sheet",
      ...approval,
    },
  })
}

async function setDepartmentFrom(tx: Tx, user: SessionUser, employeeId: string, departmentId: string, start: Date) {
  const department = await tx.department.findFirst({ where: { id: departmentId, organizationId: user.organizationId, archivedAt: null } })
  if (!department) throw new UserInputError("Department not found.")
  const current = await tx.employeeAssignment.findFirst({
    where: { employeeId, isPrimary: true, validFrom: { lte: start }, OR: [{ validTo: null }, { validTo: { gt: start } }] },
  })
  if (current?.departmentId === departmentId) return
  const next = await tx.employeeAssignment.findFirst({ where: { employeeId, isPrimary: true, validFrom: { gt: start } }, orderBy: { validFrom: "asc" } })
  if (current && current.validFrom.getTime() === start.getTime()) {
    await tx.employeeAssignment.update({ where: { id: current.id }, data: { departmentId, teamId: null } })
    return
  }
  if (current) await tx.employeeAssignment.update({ where: { id: current.id }, data: { validTo: start } })
  await tx.employeeAssignment.create({
    data: { employeeId, departmentId, isPrimary: true, allocationRate: 1, validFrom: start, validTo: current?.validTo ?? next?.validFrom ?? null },
  })
}

/**
 * KPI target or actual for one month. A target can be recurring (it then also applies to later months
 * without a target of their own); when `recurring` is not given, the month keeps the recurrence it had
 * (its own target's, or the inherited target's). KPI actuals always belong to their month only.
 */
async function setKpi(tx: Tx, user: SessionUser, employeeId: string, periodId: string, field: "kpiTarget" | "kpiActual", value: Decimal | null, recurring?: boolean) {
  const kpi = await profitKpi(tx, user.organizationId)
  const key = { kpiDefinitionId_periodId_scopeKey: { kpiDefinitionId: kpi.id, periodId, scopeKey: `EMPLOYEE:${employeeId}` } }
  const base = { organizationId: user.organizationId, kpiDefinitionId: kpi.id, periodId, scope: "EMPLOYEE" as const, scopeKey: `EMPLOYEE:${employeeId}`, employeeId }
  if (field === "kpiTarget") {
    if (value === null) await tx.kpiTarget.deleteMany({ where: { kpiDefinitionId: kpi.id, periodId, scopeKey: base.scopeKey } })
    else {
      let repeat = recurring
      if (repeat === undefined) {
        const own = await tx.kpiTarget.findUnique({ where: key })
        const period = await tx.financialPeriod.findUniqueOrThrow({ where: { id: periodId }, select: { startDate: true } })
        const inherited = own ? null : await tx.kpiTarget.findFirst({ where: { kpiDefinitionId: kpi.id, employeeId, recurring: true, period: { startDate: { lt: period.startDate } } } })
        repeat = own?.recurring ?? !!inherited
      }
      await tx.kpiTarget.upsert({ where: key, create: { ...base, targetValue: value.toString(), recurring: repeat }, update: { targetValue: value.toString(), recurring: repeat } })
    }
  } else {
    if (value === null) await tx.kpiActual.deleteMany({ where: { kpiDefinitionId: kpi.id, periodId, scopeKey: base.scopeKey } })
    else
      await tx.kpiActual.upsert({
        where: key,
        create: { ...base, actualValue: value.toString(), recordedById: user.id },
        update: { actualValue: value.toString(), recordedById: user.id },
      })
  }
}

/**
 * The sheet's Bonus / Deductions cells manage one adjustment per employee and month. It is approved
 * immediately when the editor may approve adjustments; otherwise it waits for approval and is not paid.
 */
async function setSheetAdjustment(tx: Tx, user: SessionUser, employeeId: string, periodId: string, type: "BONUS" | "DEDUCTION", amount: Decimal | null, m: Month) {
  const existing = await tx.payrollAdjustment.findFirst({
    where: { employeeId, periodId, type, status: { in: ["PENDING", "APPROVED"] }, reason: { startsWith: "Sheet" } },
  })
  const canApprove = user.permissions.has("adjustment:approve")
  const decision = canApprove ? { status: "APPROVED" as const, approvedById: user.id, decidedAt: new Date() } : { status: "PENDING" as const, approvedById: null, decidedAt: null }
  if (!amount || amount.isZero()) {
    if (existing) await tx.payrollAdjustment.update({ where: { id: existing.id }, data: { status: "CANCELLED" } })
    return
  }
  const salary = await tx.salaryCondition.findFirst({ where: { employeeId, ...overlapsMonth(m) }, orderBy: { validFrom: "desc" } })
  const data = { amount: amount.toString(), currency: salary?.currency ?? user.baseCurrency, ...decision }
  if (existing) {
    await tx.payrollAdjustment.update({ where: { id: existing.id }, data })
  } else {
    await tx.payrollAdjustment.create({
      data: { organizationId: user.organizationId, employeeId, periodId, type, reason: type === "BONUS" ? "Sheet bonus" : "Sheet deduction", requestedById: user.id, ...data },
    })
  }
}

async function setWallet(tx: Tx, user: SessionUser, employeeId: string, address: string) {
  const current = await tx.payoutWallet.findFirst({ where: { employeeId, archivedAt: null, isDefault: true } })
  if (current) await tx.payoutWallet.update({ where: { id: current.id }, data: { archivedAt: new Date(), isDefault: false } })
  if (!address) return
  if (address.length < 8 || address.length > 200 || /\s/.test(address)) throw new UserInputError("That does not look like a wallet address.")
  const network = detectNetwork(address)
  await tx.payoutWallet.create({
    data: {
      employeeId,
      type: "CRYPTO_WALLET",
      label: network ? `USDT ${network}` : "Wallet",
      currency: "USDT",
      network,
      maskedIdentifier: maskIdentifier(address),
      detailsEncrypted: encryptSecret(address),
      isDefault: true,
    },
  })
  void user
}

export async function revealWallet(user: SessionUser, walletId: string, db: Db = prisma) {
  if (!user.permissions.has("wallet:manage")) throw new UserInputError("You do not have permission to view full wallet addresses.")
  const wallet = await db.payoutWallet.findFirst({ where: { id: walletId, employee: { organizationId: user.organizationId } } })
  if (!wallet?.detailsEncrypted) throw new UserInputError("Wallet not found.")
  await inTx(db, (tx) => audit(tx, user, "wallet.reveal", "payout_wallet", walletId))
  return decryptSecret(wallet.detailsEncrypted)
}

/** Sets the employee's compensation rule from the month's first day (versioned; history kept). */
export async function setCompensationRule(user: SessionUser, m: Month, employeeId: string, config: RuleConfig, db: Db = prisma) {
  if (!user.permissions.has("compensation:manage")) throw new UserInputError("You do not have permission to change compensation terms.")
  return inTx(db, async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId: user.organizationId } })
    if (!employee) throw new UserInputError("Employee not found.")
    const { run } = await editableMonth(tx, user, m)
    const start = monthStart(m)
    const kpi = await profitKpi(tx, user.organizationId)
    const code = `EMP-${employee.employeeNumber}`.slice(0, 60)

    const currentAssignment = await tx.compensationAssignment.findFirst({
      where: { employeeId, validFrom: { lte: start }, OR: [{ validTo: null }, { validTo: { gt: start } }], rule: { code } },
      include: { rule: true },
    })
    const nextRule = await tx.compensationRule.findFirst({ where: { organizationId: user.organizationId, code, validFrom: { gt: start } }, orderBy: { validFrom: "asc" } })
    const endsAt = currentAssignment?.validTo ?? nextRule?.validFrom ?? null

    if (currentAssignment) {
      const usedByPayroll = await tx.payrollItemLine.count({ where: { compensationRuleId: currentAssignment.ruleId } })
      if (currentAssignment.validFrom.getTime() === start.getTime() && usedByPayroll === 0) {
        await tx.compensationAssignment.delete({ where: { id: currentAssignment.id } })
        await tx.compensationRule.delete({ where: { id: currentAssignment.ruleId } })
      } else {
        await tx.compensationAssignment.update({ where: { id: currentAssignment.id }, data: { validTo: start } })
        await tx.compensationRule.update({ where: { id: currentAssignment.ruleId }, data: { validTo: start } })
      }
    }

    if (config.model !== "NONE") {
      const spec = MODEL_MAP[config.model]
      const pct = (raw: string | null | undefined, label: string) => {
        const value = parseCellAmount(raw ?? "", label, { allowEmpty: false })!
        if (value.gt(100)) throw new UserInputError(`${label} cannot exceed 100%.`)
        return value.div(100)
      }
      const rate = ["PERCENT_OF_METRIC", "PERCENT_OF_BASE"].includes(spec.method) ? pct(config.ratePct, "Rate") : null
      const fixedAmount = spec.method === "FIXED_AMOUNT" ? parseCellAmount(config.fixedAmount ?? "", "Bonus amount", { allowEmpty: false }) : null
      const capAmount = parseCellAmount(config.capAmount ?? "", "Cap")
      const tiers = spec.method === "TIERED" ? (config.tiers ?? []) : []
      if (spec.method === "TIERED" && tiers.length === 0) throw new UserInputError("Add at least one tier.")
      const lastVersion = await tx.compensationRule.aggregate({ where: { organizationId: user.organizationId, code }, _max: { version: true } })
      const salary = await tx.salaryCondition.findFirst({ where: { employeeId, ...overlapsMonth(m) }, orderBy: { validFrom: "desc" } })

      const rule = await tx.compensationRule.create({
        data: {
          organizationId: user.organizationId,
          code,
          version: (lastVersion._max.version ?? 0) + 1,
          name: `${employee.firstName} ${employee.lastName}`.trim(),
          type: spec.type,
          method: spec.method,
          metricBasis: spec.basis,
          rate: rate?.toString(),
          fixedAmount: fixedAmount?.toString(),
          capAmount: capAmount?.toString(),
          currency: fixedAmount || capAmount ? (salary?.currency ?? user.baseCurrency) : null,
          kpiDefinitionId: spec.usesKpi ? kpi.id : null,
          validFrom: start,
          validTo: endsAt,
          tiers: {
            create: tiers.map((t, index) => ({
              sortOrder: index + 1,
              fromValue: parseCellAmount(t.from, "Tier from", { allowEmpty: false })!.toString(),
              toValue: parseCellAmount(t.to ?? "", "Tier to")?.toString() ?? null,
              rate: pct(t.ratePct, "Tier rate").toString(),
            })),
          },
        },
      })
      await tx.compensationAssignment.create({ data: { ruleId: rule.id, employeeId, validFrom: start, validTo: endsAt } })
    }

    const unconfirmed = await unconfirm(tx, run?.id, employeeId)
    await audit(tx, user, "sheet.update.terms", "employee", employeeId, { month: `${m.year}-${m.month}`, model: config.model, ratePct: config.ratePct ?? null, unconfirmed })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Adding employees from the sheet
// ─────────────────────────────────────────────────────────────────────────────

export async function addSheetEmployee(
  user: SessionUser,
  m: Month,
  input: { name: string; departmentId: string; fix: string; currency: string; hireDate: Date | null },
  db: Db = prisma,
) {
  for (const p of ["employee:manage", "salary:manage"] as const) {
    if (!user.permissions.has(p)) throw new UserInputError("Adding an employee requires permission to manage employees and salaries.")
  }
  return inTx(db, async (tx) => {
    const { period } = await editableMonth(tx, user, m)
    const name = input.name.trim()
    if (!name) throw new UserInputError("Name is required.")
    const department = await tx.department.findFirst({ where: { id: input.departmentId, organizationId: user.organizationId, archivedAt: null } })
    if (!department) throw new UserInputError("Choose a department.")
    const amount = parseCellAmount(input.fix, "FIX", { allowEmpty: false })!
    if (!["USD", "EUR", "GBP", "USDT"].includes(input.currency)) throw new UserInputError("Choose a supported currency.")
    const hireDate = input.hireDate ?? monthStart(m)
    const effective = hireDate > monthStart(m) ? hireDate : monthStart(m)

    const count = await tx.employee.count({ where: { organizationId: user.organizationId } })
    let number = count + 1
    while (await tx.employee.findUnique({ where: { organizationId_employeeNumber: { organizationId: user.organizationId, employeeNumber: `E${String(number).padStart(3, "0")}` } } })) number++
    const [first, ...rest] = name.split(/\s+/)
    const employee = await tx.employee.create({
      data: {
        organizationId: user.organizationId,
        employeeNumber: `E${String(number).padStart(3, "0")}`,
        firstName: first,
        lastName: rest.join(" "),
        hireDate,
        status: "ACTIVE",
      },
    })
    await tx.employeeAssignment.create({ data: { employeeId: employee.id, departmentId: department.id, isPrimary: true, allocationRate: 1, validFrom: effective } })
    const approved = user.permissions.has("salary:approve")
    await tx.salaryCondition.create({
      data: {
        employeeId: employee.id,
        payBasis: "MONTHLY",
        baseAmount: amount.toString(),
        currency: input.currency,
        validFrom: effective,
        changeReason: "Starting salary",
        approvedById: approved ? user.id : null,
        approvedAt: approved ? new Date() : null,
      },
    })
    await tx.payrollMonthEmployee.create({ data: { organizationId: user.organizationId, periodId: period.id, employeeId: employee.id, source: "NEW", createdById: user.id } })
    await audit(tx, user, "employee.create", "employee", employee.id, { name, departmentId: department.id, via: "sheet" })
    return employee
  })
}

export async function setEmployeeArchived(user: SessionUser, employeeId: string, archived: boolean, db: Db = prisma) {
  if (!user.permissions.has("employee:manage")) throw new UserInputError("You do not have permission to archive employees.")
  return inTx(db, async (tx) => {
    const { count } = await tx.employee.updateMany({ where: { id: employeeId, organizationId: user.organizationId }, data: { archivedAt: archived ? new Date() : null } })
    if (!count) throw new UserInputError("Employee not found.")
    await audit(tx, user, archived ? "employee.archive" : "employee.restore", "employee", employeeId)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm rows, approve the month, record payments
// ─────────────────────────────────────────────────────────────────────────────

/** Confirms (snapshots) or un-confirms one employee's payslip for the month. */
export async function setRowConfirmed(user: SessionUser, m: Month, employeeId: string, confirmed: boolean, db: Db = prisma) {
  if (!user.permissions.has("payroll:prepare")) throw new UserInputError("You do not have permission to confirm payroll.")
  return inTx(db, async (tx) => {
    const { period } = await editableMonth(tx, user, m)
    let run = await findRun(tx, user.organizationId, m)
    if (!confirmed) {
      await unconfirm(tx, run?.id, employeeId)
      await audit(tx, user, "payroll_item.unconfirm", "employee", employeeId, { month: `${m.year}-${m.month}` })
      return
    }

    const sheet = await getSheet(user, m, tx)
    const row = sheet.rows.find((r) => r.employeeId === employeeId)
    if (!row) throw new UserInputError("Employee is not on this month's sheet.")
    if (!row.fix) throw new UserInputError(`${row.name}: enter FIX before confirming.`)
    if (!row.salaryApproved) throw new UserInputError(`${row.name}: the salary change is waiting for approval (salary:approve).`)
    if (row.pendingAdjustments > 0) throw new UserInputError(`${row.name}: a bonus or deduction is waiting for approval.`)
    if (new Decimal(row.calculated).isNegative()) throw new UserInputError(`${row.name}: deductions exceed earnings.`)

    if (!run) {
      await tx.payrollRun.create({ data: { organizationId: user.organizationId, periodId: period.id, currency: user.baseCurrency } })
      run = await findRun(tx, user.organizationId, m)
    }
    if (!run) throw new Error("Payroll run could not be created")
    await unconfirm(tx, run.id, employeeId)

    // Recalculate from source records inside the transaction and snapshot every line.
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: {
        assignments: { where: { isPrimary: true, ...overlapsMonth(m) }, orderBy: { validFrom: "desc" }, take: 1 },
        salaryConditions: { where: overlapsMonth(m), orderBy: { validFrom: "desc" }, take: 1 },
        compensationScopes: { where: overlapsMonth(m), include: { rule: { include: { tiers: { orderBy: { sortOrder: "asc" } } } } } },
        kpiTargets: targetForMonth((await profitKpi(tx, user.organizationId)).id, m),
        kpiActuals: { where: { periodId: period.id, kpiDefinition: { code: PROFIT_KPI } } },
        payrollAdjustments: { where: { periodId: period.id, status: { in: ["APPROVED", "APPLIED"] } } },
      },
    })
    const salary = employee.salaryConditions[0]
    const rules = employee.compensationScopes.map((s) => s.rule)
    const kpiActual = employee.kpiActuals[0] ?? null
    const calc = calculate(salary, rules, employee.kpiTargets[0]?.targetValue ?? null, kpiActual?.actualValue ?? null, employee.payrollAdjustments)
    const fxRate = await fxRateFor(tx, user, salary.currency, m)

    await tx.payrollItem.create({
      data: {
        payrollRunId: run.id,
        employeeId,
        salaryConditionId: salary.id,
        departmentId: employee.assignments[0]?.departmentId ?? null,
        teamId: employee.assignments[0]?.teamId ?? null,
        currency: salary.currency,
        fxRateToBase: fxRate.toString(),
        grossAmount: calc.gross.toString(),
        deductionsAmount: calc.deductions.toString(),
        netAmount: calc.net.toString(),
        employerCostAmount: calc.gross.toString(),
        baseNetAmount: toBase(calc.net, fxRate).toString(),
        confirmedAt: new Date(),
        confirmedById: user.id,
        lines: {
          create: calc.lines.map((line) => ({
            lineType: line.lineType,
            description: line.description,
            amount: line.amount.toString(),
            quantity: line.quantity?.toDecimalPlaces(4).toString(),
            rate: line.rate?.toString(),
            compensationRuleId: line.ruleId ?? null,
            kpiActualId: line.source === "rule" ? (kpiActual?.id ?? null) : null,
            adjustmentId: line.adjustmentId ?? null,
          })),
        },
      },
    })
    await audit(tx, user, "payroll_item.confirm", "employee", employeeId, { month: `${m.year}-${m.month}`, net: calc.net.toString(), currency: salary.currency })
  })
}

/**
 * Approves the month: every row must be confirmed and unchanged. Records the approval, locks the
 * payslips, marks adjustments applied, and posts the payroll accrual:
 *   Dr Delivery payroll (cost of sales) or Overhead payroll (operating expense), by department
 *   Cr Payroll payable (net) / reduces the expense for deductions
 */
export async function approveMonth(user: SessionUser, m: Month, comment: string | null, db: Db = prisma) {
  if (!user.permissions.has("payroll:approve")) throw new UserInputError("You do not have permission to approve payroll.")
  return inTx(db, async (tx) => {
    // One approval at a time: a second click or a second user waits here, then finds the month approved.
    const p = await ensurePeriod(tx, user.organizationId, m)
    await tx.$executeRaw`SELECT 1 FROM payroll_runs WHERE period_id = ${p.id}::uuid FOR UPDATE`
    const { period } = await editableMonth(tx, user, m)
    const sheet = await getSheet(user, m, tx)
    const run = await findRun(tx, user.organizationId, m)
    if (!run || sheet.rows.length === 0) throw new UserInputError("Confirm the rows before approving the month.")
    const open = sheet.rows.filter((r) => !r.confirmed || r.stale)
    if (open.length) {
      throw new UserInputError(`${open.length} row(s) are not confirmed or changed after confirmation: ${open.slice(0, 5).map((r) => r.name).join(", ")}${open.length > 5 ? "…" : ""}`)
    }

    // Freeze what is being approved: later months can then change without touching this month.
    for (const r of sheet.rows) {
      await tx.payrollMonthEmployee.updateMany({
        where: { periodId: period.id, employeeId: r.employeeId, snapshot: { equals: Prisma.DbNull } },
        data: { snapshot: pickSnapshot(r as unknown as MonthSnapshot) as unknown as Prisma.InputJsonValue, snapshotAt: new Date() },
      })
    }

    if (run.status === "DRAFT") await tx.payrollRun.update({ where: { id: run.id }, data: { status: "CALCULATED", calculatedAt: new Date() } })
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "SUBMITTED" } })
    const step = (await tx.payrollApproval.count({ where: { payrollRunId: run.id } })) + 1
    await tx.payrollApproval.create({ data: { payrollRunId: run.id, step, approverId: user.id, decision: "APPROVED", comment } })
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })

    const items = await tx.payrollItem.findMany({ where: { payrollRunId: run.id }, include: { lines: true, department: true } })
    await tx.payrollAdjustment.updateMany({
      where: { id: { in: items.flatMap((i) => i.lines.map((l) => l.adjustmentId).filter((id): id is string => !!id)) } },
      data: { status: "APPLIED" },
    })

    const delivery = await accountByCode(tx, user.organizationId, "5000")
    const deliveryBonus = await accountByCode(tx, user.organizationId, "5050")
    const overhead = await accountByCode(tx, user.organizationId, "6000")
    const overheadBonus = await accountByCode(tx, user.organizationId, "6050")
    const payable = await accountByCode(tx, user.organizationId, "2100")
    const advances = await accountByCode(tx, user.organizationId, "1300")
    // Base pay goes to the payroll account, variable pay (KPI, commission, bonuses) to the bonus account,
    // both on the cost-of-sales or operating side according to the department's classification.
    const lines = items.flatMap((item) => {
      const fx = new Decimal(item.fxRateToBase)
      const delivers = item.department?.costClassification === "COST_OF_SALES"
      const salaryAccount = delivers ? delivery : overhead
      const bonusAccount = delivers ? deliveryBonus : overheadBonus
      const dims = { departmentId: item.departmentId, employeeId: item.employeeId }
      const positive = (types: string[] | null) =>
        toBase(item.lines.filter((l) => new Decimal(l.amount).gt(0) && (types === null || types.includes(l.lineType))).reduce((a, l) => a.add(new Decimal(l.amount)), new Decimal(0)), fx)
      const gross = toBase(new Decimal(item.grossAmount), fx)
      const base = positive(["BASE_SALARY"])
      const variable = gross.sub(base)
      const recovery = toBase(item.lines.filter((l) => l.lineType === "ADVANCE_RECOVERY").reduce((a, l) => a.add(new Decimal(l.amount).abs()), new Decimal(0)), fx)
      const deductions = toBase(new Decimal(item.deductionsAmount), fx).sub(recovery)
      return [
        { accountId: salaryAccount, debit: base, description: "Base salary", ...dims },
        { accountId: bonusAccount, debit: variable, description: "Bonuses and commissions", ...dims },
        { accountId: salaryAccount, credit: deductions, description: "Payroll deductions", ...dims },
        { accountId: advances, credit: recovery, description: "Advance recovered", ...dims },
        { accountId: payable, credit: gross.sub(deductions).sub(recovery), description: "Net pay payable", ...dims },
      ]
    })
    const entry = await postJournal(tx, user, {
      periodId: period.id,
      entryDate: monthEnd(m),
      description: `Payroll ${monthLabel(m)}`,
      source: "PAYROLL",
      lines,
    })
    if (entry) await tx.payrollRun.update({ where: { id: run.id }, data: { journalEntryId: entry.id } })
    await audit(tx, user, "payroll_run.approve", "payroll_run", run.id, { month: `${m.year}-${m.month}`, items: items.length, journalEntryId: entry?.id ?? null })
  })
}

/** Records a (partial or full) payment of an approved payslip and posts it to the ledger. */
export async function recordPayment(
  user: SessionUser,
  m: Month,
  input: { employeeId: string; amount: Decimal; currency: string; fxRate: Decimal | null; fee: Decimal | null; financialAccountId: string; paidAt: Date; reference: string | null },
  db: Db = prisma,
) {
  if (!user.permissions.has("payroll:pay")) throw new UserInputError("You do not have permission to record payments.")
  return inTx(db, async (tx) => {
    const run = await findRun(tx, user.organizationId, m)
    if (!run || !["APPROVED", "PAYING"].includes(run.status)) throw new UserInputError("Payments can be recorded only after the month is approved.")
    const item = await tx.payrollItem.findUnique({
      where: { payrollRunId_employeeId: { payrollRunId: run.id, employeeId: input.employeeId } },
      include: { payments: { where: { status: { in: ["SENT", "CONFIRMED"] } } }, employee: { include: { payoutWallets: { where: { archivedAt: null }, orderBy: { isDefault: "desc" }, take: 1 } } } },
    })
    if (!item) throw new UserInputError("This employee has no approved payslip this month.")
    const wallet = item.employee.payoutWallets[0]
    if (!wallet) throw new UserInputError("Add the employee's wallet before recording a payment.")
    const account = await tx.financialAccount.findFirst({ where: { id: input.financialAccountId, organizationId: user.organizationId, closedAt: null } })
    if (!account) throw new UserInputError("Choose the company account the money was paid from.")

    const paymentFx = input.currency === user.baseCurrency ? new Decimal(1) : input.currency === item.currency ? new Decimal(item.fxRateToBase) : input.fxRate
    if (!paymentFx || paymentFx.lte(0)) throw new UserInputError(`Enter the ${input.currency}→${user.baseCurrency} rate for this payment.`)
    const baseAmount = toBase(input.amount, paymentFx)
    const paidBase = item.payments.reduce((acc, p) => acc.add(new Decimal(p.baseAmount)), new Decimal(0))
    const outstandingBase = new Decimal(item.baseNetAmount).sub(paidBase)
    if (baseAmount.gt(outstandingBase.add("0.01"))) throw new UserInputError("The payment is larger than the outstanding amount.")

    const period = await ensurePeriod(tx, user.organizationId, { year: input.paidAt.getUTCFullYear(), month: input.paidAt.getUTCMonth() + 1 })
    assertPeriodOpen(period, { year: period.year, month: period.month }, user)
    const fee = input.fee ?? new Decimal(0)
    const feeBase = toBase(fee, paymentFx)
    const payable = await accountByCode(tx, user.organizationId, "2100")
    const fees = await accountByCode(tx, user.organizationId, "6400")
    const entry = await postJournal(tx, user, {
      periodId: period.id,
      entryDate: input.paidAt,
      description: `Salary payment ${item.employee.firstName} ${item.employee.lastName} (${monthLabel(m)})`,
      source: "PAYROLL_PAYMENT",
      lines: [
        { accountId: payable, debit: baseAmount, employeeId: item.employeeId, departmentId: item.departmentId },
        { accountId: fees, debit: feeBase, description: "Payment fee" },
        { accountId: account.ledgerAccountId, credit: baseAmount.add(feeBase) },
      ],
    })

    const payment = await tx.payrollPayment.create({
      data: {
        payrollItemId: item.id,
        payoutWalletId: wallet.id,
        financialAccountId: account.id,
        method: account.type === "CRYPTO_WALLET" ? "CRYPTO" : account.type === "BANK" ? "BANK_TRANSFER" : "OTHER",
        status: "CONFIRMED",
        amount: input.amount.toString(),
        currency: input.currency,
        fxRateToBase: paymentFx.toString(),
        baseAmount: baseAmount.toString(),
        feeAmount: fee.toString(),
        paidAt: input.paidAt,
        externalReference: input.reference,
        journalEntryId: entry?.id ?? null,
      },
    })

    if (run.status === "APPROVED") await tx.payrollRun.update({ where: { id: run.id }, data: { status: "PAYING", payDate: input.paidAt } })
    const items = await tx.payrollItem.findMany({ where: { payrollRunId: run.id }, include: { payments: { where: { status: { in: ["SENT", "CONFIRMED"] } } } } })
    const allPaid = items.every((i) => new Decimal(i.baseNetAmount).sub(i.payments.reduce((a, p) => a.add(new Decimal(p.baseAmount)), new Decimal(0))).lte("0.01"))
    if (allPaid) await tx.payrollRun.update({ where: { id: run.id }, data: { status: "PAID" } })
    await audit(tx, user, "payroll_payment.record", "payroll_payment", payment.id, { employeeId: input.employeeId, amount: input.amount.toString(), currency: input.currency })
    return payment
  })
}

/** Compensation history of one employee: salary agreements, rules and payslips. */
export async function compensationHistory(user: SessionUser, employeeId: string, db: Db = prisma) {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, organizationId: user.organizationId },
    include: {
      salaryConditions: { orderBy: { validFrom: "desc" } },
      compensationScopes: { include: { rule: { include: { tiers: true } } }, orderBy: { validFrom: "desc" } },
      payrollItems: { include: { payrollRun: { include: { period: true } }, payments: true }, orderBy: { createdAt: "desc" }, take: 24 },
    },
  })
  if (!employee) throw new UserInputError("Employee not found.")
  return {
    salaries: employee.salaryConditions.map((s) => ({ from: s.validFrom.toISOString().slice(0, 10), to: s.validTo?.toISOString().slice(0, 10) ?? null, amount: s.baseAmount.toString(), currency: s.currency, reason: s.changeReason, approved: !!s.approvedById })),
    rules: employee.compensationScopes.map((a) => ({ from: a.validFrom.toISOString().slice(0, 10), to: a.validTo?.toISOString().slice(0, 10) ?? null, terms: describeRule(ruleInput(a.rule)) })),
    payslips: employee.payrollItems.map((i) => ({
      month: `${i.payrollRun.period.year}-${String(i.payrollRun.period.month).padStart(2, "0")}`,
      status: i.payrollRun.status,
      net: i.netAmount.toString(),
      currency: i.currency,
      paid: i.payments.filter((p) => p.status === "CONFIRMED" || p.status === "SENT").reduce((a, p) => a.add(new Decimal(p.amount)), new Decimal(0)).toString(),
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Monthly approval preview and carrying employees forward
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalIssue = { employeeId: string; name: string; reason: "unconfirmed" | "changed" | "no_fix" | "salary_not_approved" | "pending_adjustment" | "negative" }

/** What approving the month would do, and what still blocks it (shown before approving). */
export async function approvalPreview(user: SessionUser, m: Month, db: Db = prisma) {
  if (!user.permissions.has("payroll:read")) throw new UserInputError("You do not have permission to view payroll.")
  const sheet = await getSheet(user, m, db)
  const run = await findRun(db, user.organizationId, m)
  const issues: ApprovalIssue[] = []
  for (const r of sheet.rows) {
    const reason: ApprovalIssue["reason"] | null = !r.fix
      ? "no_fix"
      : !r.salaryApproved
        ? "salary_not_approved"
        : r.pendingAdjustments > 0
          ? "pending_adjustment"
          : new Decimal(r.calculated).isNegative()
            ? "negative"
            : r.stale
              ? "changed"
              : !r.confirmed
                ? "unconfirmed"
                : null
    if (reason) issues.push({ employeeId: r.employeeId, name: r.name, reason })
  }
  const totals = new Map<string, Decimal>()
  for (const r of sheet.rows) totals.set(r.currency, (totals.get(r.currency) ?? new Decimal(0)).add(r.confirmed && !r.stale && r.approved ? r.approved : r.calculated))
  const approval = run?.approvals.find((a) => a.decision === "APPROVED") ?? null
  return {
    month: `${m.year}-${String(m.month).padStart(2, "0")}`,
    runStatus: run?.status ?? null,
    editable: sheet.editable,
    employees: sheet.rows.length,
    confirmed: sheet.rows.filter((r) => r.confirmed && !r.stale).length,
    totals: [...totals.entries()].map(([currency, amount]) => ({ currency, amount: amount.toString() })),
    issues,
    approvedBy: approval?.approver.email ?? null,
    approvedAt: approval?.decidedAt.toISOString() ?? null,
    canApprove: sheet.editable && sheet.rows.length > 0 && issues.length === 0 && user.permissions.has("payroll:approve"),
  }
}

export type CarryForwardItem = {
  employeeId: string
  fix?: string | null
  currency?: string | null
  departmentId?: string | null
  kpiTarget?: string | null
  kpiRecurring?: boolean
  ratePct?: string | null
}

const previousMonth = (m: Month): Month => (m.month === 1 ? { year: m.year - 1, month: 12 } : { year: m.year, month: m.month - 1 })
const APPROVED_RUN = ["APPROVED", "PAYING", "PAID"]

/**
 * Rollover preview for a month: the immediately previous month's employees (with the approved terms
 * they would carry), whether that month is approved, and who is already on this month's sheet.
 * Employees on neither sheet (e.g. created on the Employees page) are listed separately to add as new.
 */
export async function carryForwardPreview(user: SessionUser, m: Month, db: Db = prisma) {
  if (!user.permissions.has("payroll:read")) throw new UserInputError("You do not have permission to view payroll.")
  const prev = previousMonth(m)
  const prevRun = await findRun(db, user.organizationId, prev)
  const [before, now] = [await getSheet(user, prev, db), await getSheet(user, m, db)]
  const present = new Set(now.rows.map((r) => r.employeeId))
  const start = monthStart(m)
  const others = await db.employee.findMany({
    where: {
      organizationId: user.organizationId,
      archivedAt: null,
      hireDate: { lte: monthEnd(m) },
      OR: [{ terminationDate: null }, { terminationDate: { gte: start } }],
      id: { notIn: [...before.rows.map((r) => r.employeeId), ...present] },
    },
    select: { id: true, firstName: true, lastName: true, hireDate: true },
    orderBy: { firstName: "asc" },
  })
  return {
    previous: `${prev.year}-${String(prev.month).padStart(2, "0")}`,
    previousStatus: prevRun?.status ?? null,
    previousApproved: !!prevRun && APPROVED_RUN.includes(prevRun.status),
    employees: before.rows.map((r) => ({
      employeeId: r.employeeId,
      name: r.name,
      hireDate: r.hireDate,
      terminated: !!r.terminationDate && new Date(`${r.terminationDate}T00:00:00Z`) < start,
      departmentId: r.departmentId,
      departmentName: r.departmentName,
      fix: r.fix,
      currency: r.currency,
      terms: r.terms,
      ratePct: r.rule.ratePct ?? null,
      model: r.rule.model,
      kpiTarget: r.kpiTargetRecurring || r.kpiTargetInherited ? r.kpiTarget : null,
      kpiRecurring: r.kpiTargetRecurring || r.kpiTargetInherited,
      present: present.has(r.employeeId),
    })),
    others: others.map((e) => ({ employeeId: e.id, name: [e.firstName, e.lastName].filter(Boolean).join(" "), hireDate: e.hireDate.toISOString().slice(0, 10) })),
  }
}

/**
 * Moves employees one month forward, from the immediately previous month, which must be approved.
 * Each carried employee gets a row on this month's roster and this month's terms (the previous
 * month's approved department, FIX and commission terms, with any edits from the preview, starting
 * this month). Employees already on this month's sheet are skipped, never overwritten; people who
 * left before this month are skipped. `addNew` adds employees who were on neither sheet as new.
 * The previous month and its records are never changed.
 */
export async function carryForwardEmployees(user: SessionUser, m: Month, items: CarryForwardItem[], db: Db = prisma, options: { addNew?: string[] } = {}) {
  for (const p of ["employee:manage", "salary:manage"] as const) if (!user.permissions.has(p)) throw new UserInputError("Carrying employees forward needs permission to manage employees and salaries.")
  const addNew = options.addNew ?? []
  if ((!Array.isArray(items) || items.length === 0) && addNew.length === 0) throw new UserInputError("Choose employees to carry forward.")
  if (items.length + addNew.length > 500) throw new UserInputError("Too many employees at once.")
  const prev = previousMonth(m)
  const prevLabel = monthLabel(prev)
  if (items.length) {
    const prevRun = await findRun(db, user.organizationId, prev)
    if (!prevRun || !APPROVED_RUN.includes(prevRun.status)) throw new UserInputError(`Payroll for ${prevLabel} is not approved yet. Approve it first, then carry employees over.`)
  }
  const before = items.length ? await getSheet(user, prev, db) : { rows: [] as SheetRow[] }
  let added = 0
  let skipped = 0
  const start = monthStart(m)
  for (const item of [...items.map((i) => ({ ...i, kind: "carry" as const })), ...addNew.map((employeeId) => ({ employeeId, kind: "new" as const }))]) {
    await inTx(db, async (tx) => {
      const { period, run } = await editableMonth(tx, user, m)
      const employee = await tx.employee.findFirst({ where: { id: item.employeeId, organizationId: user.organizationId } })
      if (!employee) throw new UserInputError("Employee not found.")
      await tx.$executeRaw`SELECT 1 FROM employees WHERE id = ${employee.id}::uuid FOR UPDATE`
      const existing = await tx.payrollMonthEmployee.findUnique({ where: { periodId_employeeId: { periodId: period.id, employeeId: employee.id } } })
      const left = employee.terminationDate && employee.terminationDate < start
      const source = item.kind === "carry" ? before.rows.find((r) => r.employeeId === employee.id) : null
      if (existing || left || employee.archivedAt || (item.kind === "carry" && !source)) {
        skipped++
        return
      }
      const prevPeriod = item.kind === "carry" ? await ensurePeriod(tx, user.organizationId, prev) : null
      await tx.payrollMonthEmployee.create({
        data: { organizationId: user.organizationId, periodId: period.id, employeeId: employee.id, source: item.kind === "carry" ? "CARRIED" : "NEW", carriedFromPeriodId: prevPeriod?.id ?? null, createdById: user.id },
      })
      if (item.kind === "carry" && source) {
        const edit = item as CarryForwardItem
        const departmentId = edit.departmentId || source.departmentId
        if (departmentId) await setDepartmentFrom(tx, user, employee.id, departmentId, start)
        const fix = edit.fix ? parseCellAmount(edit.fix, "FIX", { allowEmpty: false }) : source.fix ? new Decimal(source.fix) : null
        if (fix) await setSalaryFrom(tx, user, employee, m, { amount: fix, currency: edit.currency || source.currency }, "future")
        if (source.rule.model !== "NONE" && user.permissions.has("compensation:manage")) {
          const rateChanged = !!edit.ratePct && edit.ratePct !== source.rule.ratePct
          const scopes = await tx.compensationAssignment.count({ where: { employeeId: employee.id, ...overlapsMonth(m) } })
          if (rateChanged || !scopes) await setCompensationRule(user, m, employee.id, rateChanged ? { ...source.rule, ratePct: edit.ratePct! } : source.rule, tx)
        }
        if (edit.kpiTarget) await setKpi(tx, user, employee.id, period.id, "kpiTarget", parseCellAmount(edit.kpiTarget, "KPI Profit"), edit.kpiRecurring ?? false)
      } else {
        const salary = await tx.salaryCondition.findFirst({ where: { employeeId: employee.id, ...overlapsMonth(m) } })
        if (!salary) throw new UserInputError(`${[employee.firstName, employee.lastName].join(" ").trim()}: no salary terms for this month. Set FIX on the Employees page or add the person as a new employee.`)
      }
      await unconfirm(tx, run?.id, employee.id)
      await audit(tx, user, item.kind === "carry" ? "sheet.carry_forward" : "sheet.add_existing", "employee", employee.id, { month: `${m.year}-${String(m.month).padStart(2, "0")}`, from: item.kind === "carry" ? `${prev.year}-${String(prev.month).padStart(2, "0")}` : null })
      added++
    })
  }
  return { added, skipped }
}
