import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listFinancialAccounts } from "@/lib/data/accounts"
import { listDepartments } from "@/lib/data/settings"
import { getSheet } from "@/lib/data/sheet"
import { getDictionary } from "@/lib/i18n/server"
import { currentMonth, monthKey, parseMonth } from "@/lib/period"

import { FinancialSheet } from "./financial-sheet"

export const metadata: Metadata = { title: "Финансовый лист" }

export default function SheetPage({ searchParams }: PageProps<"/payroll">) {
  return (
    <Suspense fallback={<PageSkeleton title="Финансовый лист" />}>
      <Sheet searchParams={searchParams} />
    </Suspense>
  )
}

async function Sheet({ searchParams }: { searchParams: PageProps<"/payroll">["searchParams"] }) {
  const user = await requirePageAccess("payroll:read")
  const params = await searchParams
  const month = parseMonth(typeof params.month === "string" ? params.month : null) ?? currentMonth()
  const { locale } = await getDictionary()
  const [sheet, departments, accounts] = await Promise.all([
    getSheet(user, month),
    listDepartments(user),
    can(user, "payroll:pay") ? listFinancialAccounts(user) : Promise.resolve([]),
  ])
  const showSalary = can(user, "salary:read")

  return (
    <FinancialSheet
      key={monthKey(month)}
      locale={locale}
      monthKey={monthKey(month)}
      baseCurrency={user.baseCurrency}
      runStatus={sheet.run?.status ?? null}
      editable={sheet.editable}
      // Salary figures are removed server-side for users without salary:read.
      rows={showSalary ? sheet.rows : sheet.rows.map((r) => ({ ...r, fix: null, variable: "0", bonus: "0", deduction: "0", calculated: "0", approved: null, paid: "0", outstanding: null }))}
      departments={departments.map((d) => ({ id: d.id, name: d.name }))}
      accounts={accounts.filter((a) => !a.closed && a.type !== "LOAN").map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
      perms={{
        employee: can(user, "employee:manage"),
        salary: can(user, "salary:manage"),
        kpi: can(user, "kpi:manage"),
        adjustment: can(user, "adjustment:request"),
        compensation: can(user, "compensation:manage"),
        wallet: can(user, "wallet:manage"),
        prepare: can(user, "payroll:prepare"),
        approve: can(user, "payroll:approve"),
        pay: can(user, "payroll:pay"),
        history: showSalary,
      }}
    />
  )
}
