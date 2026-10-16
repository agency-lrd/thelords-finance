import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { ReportHeader } from "@/components/reports/report-header"
import { requirePageAccess } from "@/lib/auth/session"
import { budgetForRange } from "@/lib/data/budgets"
import { prisma } from "@/lib/db"
import { getDictionary } from "@/lib/i18n/server"
import { reportTexts } from "@/lib/i18n/reports"
import { pnlReport } from "@/lib/reports/ledger"
import { reportParams } from "@/lib/reports/params"

import { PnlStatement } from "./statement"

export const metadata: Metadata = { title: "P&L" }

export default function PnlPage({ searchParams }: PageProps<"/pnl">) {
  return (
    <Suspense fallback={<PageSkeleton title="P&L" />}>
      <Pnl searchParams={searchParams} />
    </Suspense>
  )
}

async function Pnl({ searchParams }: { searchParams: PageProps<"/pnl">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = reportTexts[locale]
  const { range, period, departmentId, clientId } = reportParams(await searchParams)
  const filters = { departmentId, clientId }
  const [report, budget, departments, clients] = await Promise.all([
    pnlReport(user, range, filters),
    budgetForRange(user, range, { departmentId }),
    prisma.department.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.client.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ])
  const metrics = Object.fromEntries((["REVENUE", "DIRECT_COSTS", "OPEX", "EBITDA", "NET_PROFIT"] as const).map((m) => [m, budget.metric(m)]))
  const accounts: Record<string, string> = {}
  for (const section of Object.values(report.current.sections)) for (const l of section.lines) {
    const b = budget.account(l.accountId)
    if (b) accounts[l.accountId] = b
  }
  return (
    <div className="flex flex-col gap-6">
      <ReportHeader
        title={t.pnl.title}
        description={t.pnl.description}
        period={period}
        filters={{ labels: t.filters, departments, clients, departmentId, clientId }}
      />
      <PnlStatement
        locale={locale}
        currency={user.baseCurrency}
        period={period}
        filters={filters}
        current={report.current}
        previous={report.previous}
        yearAgo={report.yearAgo}
        budget={budget.hasAny ? { metrics, accounts } : null}
      />
    </div>
  )
}
