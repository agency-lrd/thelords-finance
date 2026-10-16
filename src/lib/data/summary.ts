import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { Decimal } from "@/lib/money"
import { monthIndex, type Month } from "@/lib/period"

import { prisma, type Db } from "./db"

export type DepartmentProfitRow = {
  departmentId: string | null
  departmentName: string
  costClassification: string | null
  revenue: Decimal
  projectCosts: Decimal
  payroll: Decimal
  profit: Decimal
  margin: Decimal | null
}

type Raw = { department_id: string | null; revenue: string; project_costs: string; payroll: string }

/**
 * Department profit for a month range, in the organization's base currency:
 *   revenue       recognized project income (invoiced/received) of projects owned by the department
 *   project costs incurred/paid costs of those projects
 *   payroll       gross pay of payslips snapshotted to the department (all non-cancelled sheets)
 * Uses the amounts converted at entry time, so history does not change when FX rates change.
 */
export async function departmentProfit(user: SessionUser, from: Month, to: Month, db: Db = prisma) {
  const lo = monthIndex(from)
  const hi = monthIndex(to)
  const rows = await db.$queryRaw<Raw[]>`
    WITH periods AS (
      SELECT id FROM financial_periods
      WHERE organization_id = ${user.organizationId}::uuid AND (year * 12 + month - 1) BETWEEN ${lo} AND ${hi}
    ),
    revenue AS (
      SELECT p.department_id, sum(pi.base_amount) AS amount
      FROM project_income pi JOIN projects p ON p.id = pi.project_id
      WHERE pi.period_id IN (SELECT id FROM periods) AND pi.status IN ('INVOICED', 'PARTIALLY_RECEIVED', 'RECEIVED')
      GROUP BY p.department_id
    ),
    costs AS (
      SELECT p.department_id, sum(pc.base_amount) AS amount
      FROM project_costs pc JOIN projects p ON p.id = pc.project_id
      WHERE pc.period_id IN (SELECT id FROM periods) AND pc.status IN ('INCURRED', 'PAID')
      GROUP BY p.department_id
    ),
    payroll AS (
      SELECT i.department_id, sum(round(i.gross_amount * i.fx_rate_to_base, 8)) AS amount
      FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id
      WHERE r.period_id IN (SELECT id FROM periods) AND r.status <> 'CANCELLED'
      GROUP BY i.department_id
    ),
    keys AS (
      SELECT department_id FROM revenue UNION SELECT department_id FROM costs UNION SELECT department_id FROM payroll
      UNION SELECT id FROM departments WHERE organization_id = ${user.organizationId}::uuid AND archived_at IS NULL
    )
    SELECT k.department_id,
      coalesce(r.amount, 0)::text AS revenue,
      coalesce(c.amount, 0)::text AS project_costs,
      coalesce(p.amount, 0)::text AS payroll
    FROM keys k
    LEFT JOIN revenue r ON r.department_id IS NOT DISTINCT FROM k.department_id
    LEFT JOIN costs c ON c.department_id IS NOT DISTINCT FROM k.department_id
    LEFT JOIN payroll p ON p.department_id IS NOT DISTINCT FROM k.department_id`

  const departments = await db.department.findMany({ where: { organizationId: user.organizationId } })
  const byId = new Map(departments.map((d) => [d.id, d]))

  const result: DepartmentProfitRow[] = rows
    .map((r) => {
      const revenue = new Decimal(r.revenue)
      const projectCosts = new Decimal(r.project_costs)
      const payroll = new Decimal(r.payroll)
      const profit = revenue.sub(projectCosts).sub(payroll)
      const department = r.department_id ? byId.get(r.department_id) : null
      return {
        departmentId: r.department_id,
        departmentName: department?.name ?? "Unassigned",
        costClassification: department?.costClassification ?? null,
        revenue,
        projectCosts,
        payroll,
        profit,
        margin: revenue.isZero() ? null : profit.div(revenue),
      }
    })
    .filter((r) => r.departmentId !== null || !r.revenue.isZero() || !r.projectCosts.isZero() || !r.payroll.isZero())
    .sort((a, b) => (a.departmentId === null ? 1 : b.departmentId === null ? -1 : a.departmentName.localeCompare(b.departmentName)))

  const total = result.reduce(
    (acc, r) => ({
      revenue: acc.revenue.add(r.revenue),
      projectCosts: acc.projectCosts.add(r.projectCosts),
      payroll: acc.payroll.add(r.payroll),
    }),
    { revenue: new Decimal(0), projectCosts: new Decimal(0), payroll: new Decimal(0) },
  )
  const totalProfit = total.revenue.sub(total.projectCosts).sub(total.payroll)
  return {
    rows: result,
    total: { ...total, profit: totalProfit, margin: total.revenue.isZero() ? null : totalProfit.div(total.revenue) },
  }
}
