import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { getDictionary } from "@/lib/i18n/server"
import { expenseStructure, monthlyAnalytics } from "@/lib/reports/analytics"
import { departmentPnl } from "@/lib/reports/ledger"
import { range } from "@/lib/reports/periods"

import { AnalyticsView } from "./analytics-view"

export const metadata: Metadata = { title: "Аналитика" }

export default function AnalyticsPage({ searchParams }: PageProps<"/analytics">) {
  return (
    <Suspense fallback={<PageSkeleton title="Аналитика" />}>
      <Analytics searchParams={searchParams} />
    </Suspense>
  )
}

async function Analytics({ searchParams }: { searchParams: PageProps<"/analytics">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const params = await searchParams
  const y = typeof params.year === "string" && /^\d{4}$/.test(params.year) ? Number(params.year) : new Date().getUTCFullYear()
  const year = Math.min(2100, Math.max(2000, y))
  const [data, departments, costs] = await Promise.all([monthlyAnalytics(user, year), departmentPnl(user, range("year", year)), expenseStructure(user, range("year", year))])
  return (
    <AnalyticsView
      locale={locale}
      currency={user.baseCurrency}
      data={data}
      departments={departments.map((d) => ({ name: d.name, netProfit: d.pnl.netProfit }))}
      costStructure={costs.map((c) => ({ name: c.name, amount: c.amount }))}
      canEdit={can(user, "kpi:manage")}
    />
  )
}
