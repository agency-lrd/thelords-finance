import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listFinancialAccounts } from "@/lib/data/accounts"
import { ownerMovements } from "@/lib/data/cash-register"
import { listDistributions, listOwners } from "@/lib/data/owners"
import { transactionOptions } from "@/lib/data/transactions"
import { getDictionary } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { balanceSheetReport, cashBalance, pnlReport } from "@/lib/reports/ledger"
import { range } from "@/lib/reports/periods"
import { prisma } from "@/lib/db"

import { OwnerMovements } from "./owner-movements"
import { OwnersView } from "./owners-view"

export const metadata: Metadata = { title: "Собственники" }

export default function OwnersPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Собственники" />}>
      <Owners />
    </Suspense>
  )
}

async function Owners() {
  const user = await requirePageAccess("ownership:read")
  const { locale } = await getDictionary()
  const today = new Date(new Date().toISOString().slice(0, 10))
  const year = today.getUTCFullYear()
  const canReports = can(user, "reports:read")
  const [owners, distributions, accounts, pnl, bs, cash] = await Promise.all([
    listOwners(user),
    listDistributions(user),
    listFinancialAccounts(user),
    canReports ? pnlReport(user, { ...range("year", year), to: today }) : null,
    canReports ? balanceSheetReport(user, today) : null,
    canReports ? cashBalance(prisma, user.organizationId, today) : null,
  ])
  const canLedger = can(user, "ledger:read")
  const [movements, options] = await Promise.all([ownerMovements(user), canLedger ? transactionOptions(user) : null])
  const distributedYtd = distributions
    .filter((d) => (d.status === "APPROVED" || d.status === "PAID") && d.declaredDate.startsWith(String(year)))
    .reduce((a, d) => a.add(d.totalAmount), new Decimal(0))
  return (
    <>
    <OwnersView
      locale={locale}
      currency={user.baseCurrency}
      owners={owners}
      distributions={distributions}
      reference={{ netProfitYtd: pnl?.current.netProfit ?? "0", retained: bs ? new Decimal(bs.sheet.retainedEarnings).add(bs.sheet.currentPeriodProfit).add(bs.sheet.distributions).toString() : "0", cash: cash ?? "0", distributedYtd: distributedYtd.toString() }}
      accounts={accounts.filter((a) => !a.closed && a.type !== "LOAN" && a.type !== "CREDIT_CARD").map((a) => ({ id: a.id, name: a.name }))}
      perms={{ manage: can(user, "ownership:manage"), distribute: can(user, "distribution:manage"), approve: can(user, "distribution:approve") }}
    />
    <OwnerMovements
      locale={locale}
      currency={user.baseCurrency}
      rows={movements}
      options={options ? { ...options, accounts: options.accounts.filter((a) => a.type !== "LOAN" && a.type !== "CREDIT_CARD") } : { accounts: [], departments: [], clients: [], clientCategories: [], teams: [], projects: [], shareholders: [], categories: [] }}
      canCreate={can(user, "journal:create")}
    />
    </>
  )
}
