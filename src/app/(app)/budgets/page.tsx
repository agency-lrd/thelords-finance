import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listBudget, SCENARIOS } from "@/lib/data/budgets"
import { getDictionary } from "@/lib/i18n/server"
import { monthlyAnalytics } from "@/lib/reports/analytics"
import { monthlySeries } from "@/lib/reports/ledger"
import { prisma } from "@/lib/db"

import { BudgetGrid } from "./budget-grid"

export const metadata: Metadata = { title: "Бюджеты" }

export default function BudgetsPage({ searchParams }: PageProps<"/budgets">) {
  return (
    <Suspense fallback={<PageSkeleton title="Бюджеты" />}>
      <Budgets searchParams={searchParams} />
    </Suspense>
  )
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function Budgets({ searchParams }: { searchParams: PageProps<"/budgets">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const p = await searchParams
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "")
  const year = /^\d{4}$/.test(s("year")) ? Math.min(2100, Math.max(2000, Number(s("year")))) : new Date().getUTCFullYear()
  const scenario = SCENARIOS.find((x) => x === s("scenario")) ?? "BASE"
  const departmentId = UUID.test(s("dept")) ? s("dept") : ""
  const projectId = UUID.test(s("project")) ? s("project") : ""

  const [lines, departments, projects] = await Promise.all([
    listBudget(user, year, scenario),
    prisma.department.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.project.findMany({ where: { organizationId: user.organizationId, billingModel: { not: "INTERNAL" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ])
  const budget: Record<string, Record<number, string>> = {}
  for (const l of lines) {
    if (l.metric === "ACCOUNT" || (l.departmentId ?? "") !== departmentId || (l.projectId ?? "") !== projectId) continue
    ;(budget[l.metric] ??= {})[l.month] = l.amount
  }

  // Actuals only for the base scenario; per department when a department is selected.
  let actual: Record<string, Record<number, string>> | null = null
  if (scenario === "BASE" && !projectId) {
    const [series, analytics] = await Promise.all([monthlySeries(user, year, { departmentId: departmentId || null }), departmentId ? null : monthlyAnalytics(user, year)])
    const now = new Date()
    const lastMonth = year < now.getUTCFullYear() ? 12 : year > now.getUTCFullYear() ? 0 : now.getUTCMonth() + 1
    actual = { REVENUE: {}, DIRECT_COSTS: {}, OPEX: {}, PAYROLL: {}, MARKETING: {}, EBITDA: {}, NET_PROFIT: {}, CASH_RESERVE: {} }
    for (const m of series) {
      if (m.month > lastMonth) continue
      actual.REVENUE[m.month] = m.pnl.revenue
      actual.DIRECT_COSTS[m.month] = m.pnl.costOfServices
      actual.OPEX[m.month] = m.pnl.operatingExpenses
      actual.EBITDA[m.month] = m.pnl.ebitda
      actual.NET_PROFIT[m.month] = m.pnl.netProfit
      if (!departmentId) actual.CASH_RESERVE[m.month] = m.flow.closingCash
    }
    for (const m of analytics?.months ?? []) {
      if (m.month > lastMonth) continue
      actual.PAYROLL[m.month] = m.payroll
      actual.MARKETING[m.month] = m.marketing
    }
  }

  return (
    <BudgetGrid
      locale={locale}
      currency={user.baseCurrency}
      year={year}
      scenario={scenario}
      scope={{ departmentId, projectId }}
      departments={departments}
      projects={projects}
      budget={budget}
      actual={actual}
      canEdit={can(user, "ledger:manage")}
    />
  )
}
