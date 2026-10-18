import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listFinancialAccounts } from "@/lib/data/accounts"
import { listSheetDepartments } from "@/lib/data/sheet-admin"
import { getProjectLedger } from "@/lib/data/project-ledger"
import { getSheet } from "@/lib/data/sheet"
import { getDictionary } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { currentMonth, monthKey, parseMonth } from "@/lib/period"

import { FinancialSheet } from "./financial-sheet"
import { ProjectLedger } from "./project-ledger"

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
  const showLedger = can(user, "project_finance:read")
  const [sheet, departments, accounts, ledger] = await Promise.all([
    getSheet(user, month),
    listSheetDepartments(user, month),
    can(user, "payroll:pay") || can(user, "project_finance:manage") ? listFinancialAccounts(user) : Promise.resolve([]),
    showLedger ? getProjectLedger(user, month) : Promise.resolve(null),
  ])
  const showSalary = can(user, "salary:read")

  // Department payroll for the contribution table: the approved amount where a row is confirmed,
  // otherwise the live calculation. Base-currency rows only (others need an FX rate first).
  const payrollByDepartment: Record<string, string> = {}
  if (showSalary) {
    for (const r of sheet.rows) {
      if (!r.departmentId || r.currency !== user.baseCurrency) continue
      const value = new Decimal(payrollByDepartment[r.departmentId] ?? 0).add(r.confirmed && r.approved ? r.approved : r.calculated)
      payrollByDepartment[r.departmentId] = value.toString()
    }
  }
  const openAccounts = accounts.filter((a) => !a.closed && a.type !== "LOAN").map((a) => ({ id: a.id, name: a.name, currency: a.currency }))

  return (
    <>
    <FinancialSheet
      key={monthKey(month)}
      locale={locale}
      monthKey={monthKey(month)}
      baseCurrency={user.baseCurrency}
      runStatus={sheet.run?.status ?? null}
      editable={sheet.editable}
      // Salary figures are removed server-side for users without salary:read.
      rows={showSalary ? sheet.rows : sheet.rows.map((r) => ({ ...r, fix: null, variable: "0", bonus: "0", deduction: "0", calculated: "0", approved: null, paid: "0", outstanding: null }))}
      departments={departments}
      accounts={can(user, "payroll:pay") ? openAccounts : []}
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
        structure: can(user, "structure:manage"),
        deleteEmployee: can(user, "employee:manage") && can(user, "salary:manage"),
      }}
    />
    {ledger && (
      <ProjectLedger
        key={`ledger-${monthKey(month)}`}
        locale={locale}
        monthKey={monthKey(month)}
        baseCurrency={user.baseCurrency}
        ledger={ledger}
        payrollByDepartment={payrollByDepartment}
        accounts={openAccounts}
        canManage={can(user, "project_finance:manage")}
        open={sheet.periodStatus !== "CLOSED" && sheet.periodStatus !== "LOCKED"}
      />
    )}
    </>
  )
}
