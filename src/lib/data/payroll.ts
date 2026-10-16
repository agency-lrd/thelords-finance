import "server-only"

import type { PayrollLineType } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal, sum, toBase } from "@/lib/money"
import { monthEnd, monthLabel, monthStart, type Month } from "@/lib/period"

import { assertPeriodOpen, audit, ensurePeriod, fxRateFor, type Tx } from "./common"
import { inTx, prisma, type Db } from "./db"

/** Line types offered on the sheet. Deduction types are stored as negative amounts. */
export const EARNING_LINES = ["BASE_SALARY", "BONUS", "KPI_BONUS", "COMMISSION", "ALLOWANCE", "OVERTIME", "REIMBURSEMENT"] as const
export const DEDUCTION_LINES = ["DEDUCTION", "TAX_WITHHOLDING", "ADVANCE_RECOVERY"] as const
export const SHEET_LINE_TYPES = [...EARNING_LINES, ...DEDUCTION_LINES] as const
export type SheetLineType = (typeof SHEET_LINE_TYPES)[number]

const isDeduction = (type: string) => (DEDUCTION_LINES as readonly string[]).includes(type)

async function findRun(db: Db | Tx, organizationId: string, m: Month) {
  return db.payrollRun.findFirst({
    where: { organizationId, runType: "REGULAR", sequence: 1, period: { year: m.year, month: m.month } },
    include: { period: true, approvals: { include: { approver: { select: { email: true } } }, orderBy: { decidedAt: "asc" } } },
  })
}

export async function getSheet(user: SessionUser, m: Month, db: Db = prisma) {
  const run = await findRun(db, user.organizationId, m)
  const items = run
    ? await db.payrollItem.findMany({
        where: { payrollRunId: run.id },
        include: {
          employee: true,
          department: true,
          lines: { orderBy: { createdAt: "asc" } },
          salaryCondition: true,
        },
        orderBy: [{ employee: { lastName: "asc" } }, { employee: { firstName: "asc" } }],
      })
    : []

  const totals = {
    grossBase: sum(items.map((i) => toBase(new Decimal(i.grossAmount), new Decimal(i.fxRateToBase)))),
    deductionsBase: sum(items.map((i) => toBase(new Decimal(i.deductionsAmount), new Decimal(i.fxRateToBase)))),
    netBase: sum(items.map((i) => new Decimal(i.baseNetAmount))),
  }
  return { run, items, totals, editable: !run || run.status === "DRAFT" || run.status === "CALCULATED" }
}

/** Creates (or completes) the month's sheet from each employee's salary and department in that month. */
export async function generateSheet(user: SessionUser, m: Month, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m)

    let run = await findRun(tx, user.organizationId, m)
    if (!run) {
      await tx.payrollRun.create({
        data: { organizationId: user.organizationId, periodId: period.id, runType: "REGULAR", sequence: 1, currency: user.baseCurrency },
      })
      run = await findRun(tx, user.organizationId, m)
    }
    if (!run) throw new Error("Payroll run could not be created")
    if (run.status !== "DRAFT" && run.status !== "CALCULATED") {
      throw new UserInputError(`The ${monthLabel(m)} sheet is ${run.status.toLowerCase()} and can no longer be changed.`)
    }

    const start = monthStart(m)
    const end = monthEnd(m)
    const employees = await tx.employee.findMany({
      where: {
        organizationId: user.organizationId,
        hireDate: { lte: end },
        OR: [{ terminationDate: null }, { terminationDate: { gte: start } }],
        payrollItems: { none: { payrollRunId: run.id } },
      },
      include: {
        salaryConditions: {
          where: { validFrom: { lte: end }, OR: [{ validTo: null }, { validTo: { gt: start } }] },
          orderBy: { validFrom: "desc" },
          take: 1,
        },
        assignments: {
          where: { isPrimary: true, validFrom: { lte: end }, OR: [{ validTo: null }, { validTo: { gt: start } }] },
          orderBy: { validFrom: "desc" },
          take: 1,
        },
      },
    })

    const skipped: string[] = []
    let added = 0
    for (const employee of employees) {
      const salary = employee.salaryConditions[0]
      if (!salary) {
        skipped.push(`${employee.firstName} ${employee.lastName} (no salary for this month)`)
        continue
      }
      const fxRate = await fxRateFor(tx, user, salary.currency, m)
      const item = await tx.payrollItem.create({
        data: {
          payrollRunId: run.id,
          employeeId: employee.id,
          salaryConditionId: salary.id,
          departmentId: employee.assignments[0]?.departmentId ?? null,
          teamId: employee.assignments[0]?.teamId ?? null,
          currency: salary.currency,
          fxRateToBase: fxRate,
        },
      })
      // Monthly and fixed-fee pay is added automatically; hourly/daily pay is entered on the sheet.
      if (salary.payBasis === "MONTHLY" || salary.payBasis === "FIXED_FEE") {
        await tx.payrollItemLine.create({
          data: { payrollItemId: item.id, lineType: "BASE_SALARY", description: "Base salary", amount: salary.baseAmount },
        })
      }
      await recalculateItem(tx, item.id)
      added++
    }

    await audit(tx, user, "payroll_sheet.generate", "payroll_run", run.id, { month: `${m.year}-${m.month}`, added, skipped: skipped.length })
    return { added, skipped }
  })
}

/** Recomputes a payslip's totals from its lines (exact decimals). */
async function recalculateItem(tx: Tx, itemId: string) {
  const item = await tx.payrollItem.findUniqueOrThrow({ where: { id: itemId }, include: { lines: true } })
  const amounts = item.lines.map((l) => new Decimal(l.amount))
  const gross = sum(amounts.filter((a) => a.isPositive()))
  const deductions = sum(amounts.filter((a) => a.isNegative())).abs()
  const net = gross.sub(deductions)
  if (net.isNegative()) throw new UserInputError("Deductions cannot exceed earnings for a payslip.")
  await tx.payrollItem.update({
    where: { id: itemId },
    data: {
      grossAmount: gross,
      deductionsAmount: deductions,
      netAmount: net,
      employerCostAmount: gross,
      baseNetAmount: toBase(net, new Decimal(item.fxRateToBase)),
    },
  })
}

async function editableItem(tx: Tx, user: SessionUser, itemId: string) {
  const item = await tx.payrollItem.findFirst({
    where: { id: itemId, payrollRun: { organizationId: user.organizationId } },
    include: { payrollRun: true },
  })
  if (!item) throw new UserInputError("Payslip not found.")
  if (item.payrollRun.status !== "DRAFT" && item.payrollRun.status !== "CALCULATED") {
    throw new UserInputError("This month's sheet is approved and can no longer be changed.")
  }
  return item
}

export async function addSheetLine(
  user: SessionUser,
  itemId: string,
  input: { lineType: SheetLineType; description: string; amount: Decimal },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    await editableItem(tx, user, itemId)
    const amount = isDeduction(input.lineType) ? input.amount.neg() : input.amount
    const line = await tx.payrollItemLine.create({
      data: { payrollItemId: itemId, lineType: input.lineType as PayrollLineType, description: input.description, amount },
    })
    await recalculateItem(tx, itemId)
    await audit(tx, user, "payroll_line.create", "payroll_item_line", line.id, {
      itemId,
      lineType: input.lineType,
      amount: amount.toString(),
    })
    return line
  })
}

/** Removes a line from a draft sheet only (approved sheets are immutable). */
export async function removeSheetLine(user: SessionUser, lineId: string, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const line = await tx.payrollItemLine.findFirst({
      where: { id: lineId, payrollItem: { payrollRun: { organizationId: user.organizationId } } },
    })
    if (!line) throw new UserInputError("Line not found.")
    await editableItem(tx, user, line.payrollItemId)
    await tx.payrollItemLine.delete({ where: { id: lineId } })
    await recalculateItem(tx, line.payrollItemId)
    await audit(tx, user, "payroll_line.remove", "payroll_item_line", lineId, {
      itemId: line.payrollItemId,
      lineType: line.lineType,
      amount: new Decimal(line.amount).toString(),
    })
  })
}

/** Approves the month: DRAFT/CALCULATED -> SUBMITTED -> APPROVED with a recorded approval. Locks the sheet. */
export async function approveSheet(user: SessionUser, m: Month, comment: string | null, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const run = await findRun(tx, user.organizationId, m)
    if (!run) throw new UserInputError(`There is no sheet for ${monthLabel(m)} yet.`)
    if (run.status !== "DRAFT" && run.status !== "CALCULATED") throw new UserInputError(`The sheet is already ${run.status.toLowerCase()}.`)
    const count = await tx.payrollItem.count({ where: { payrollRunId: run.id } })
    if (!count) throw new UserInputError("The sheet has no employees.")

    if (run.status === "DRAFT") {
      await tx.payrollRun.update({ where: { id: run.id }, data: { status: "CALCULATED", calculatedAt: new Date() } })
    }
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "SUBMITTED" } })
    const step = (await tx.payrollApproval.count({ where: { payrollRunId: run.id } })) + 1
    await tx.payrollApproval.create({ data: { payrollRunId: run.id, step, approverId: user.id, decision: "APPROVED", comment } })
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "APPROVED" } })
    await audit(tx, user, "payroll_sheet.approve", "payroll_run", run.id, { month: `${m.year}-${m.month}` })
  })
}

export async function markSheetPaid(user: SessionUser, m: Month, payDate: Date, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const run = await findRun(tx, user.organizationId, m)
    if (!run || run.status !== "APPROVED") throw new UserInputError("Only an approved sheet can be marked as paid.")
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "PAYING", payDate } })
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "PAID" } })
    await audit(tx, user, "payroll_sheet.mark_paid", "payroll_run", run.id, { payDate: payDate.toISOString().slice(0, 10) })
  })
}
