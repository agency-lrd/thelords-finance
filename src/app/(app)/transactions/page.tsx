import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import type { TransactionType } from "@/generated/prisma/client"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listFinancialAccounts } from "@/lib/data/accounts"
import { listSalaryPayments } from "@/lib/data/cash-register"
import { listTransactions, TRANSACTION_TYPES, transactionOptions } from "@/lib/data/transactions"
import { getDictionary } from "@/lib/i18n/server"

import { TransactionsWorkspace } from "./workspace"

export const metadata: Metadata = { title: "Транзакции" }

export default function TransactionsPage({ searchParams }: PageProps<"/transactions">) {
  return (
    <Suspense fallback={<PageSkeleton title="Транзакции" />}>
      <Transactions searchParams={searchParams} />
    </Suspense>
  )
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function Transactions({ searchParams }: { searchParams: PageProps<"/transactions">["searchParams"] }) {
  const user = await requirePageAccess("ledger:read")
  const { locale } = await getDictionary()
  const p = await searchParams
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "")
  const d = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s(k)) ? new Date(`${s(k)}T00:00:00Z`) : null)
  const id = (k: string) => (UUID.test(s(k)) ? s(k) : null)
  const filters = {
    from: d("from"),
    to: d("to"),
    type: TRANSACTION_TYPES.includes(s("type") as TransactionType) ? (s("type") as TransactionType) : null,
    status: (["DRAFT", "POSTED", "REVERSED"] as const).find((x) => x === s("status")) ?? null,
    financialAccountId: id("account"),
    departmentId: id("dept"),
    categoryId: id("category"),
    search: s("q").slice(0, 100) || null,
  }
  const [rows, options, balances, salaryPayments] = await Promise.all([
    listTransactions(user, filters),
    transactionOptions(user),
    listFinancialAccounts(user),
    // Salary payments are payroll records; shown here as the same records (filtered like the register).
    filters.type || filters.departmentId || filters.categoryId || filters.search || filters.status === "DRAFT" ? Promise.resolve([]) : listSalaryPayments(user, filters),
  ])
  return (
    <TransactionsWorkspace
      locale={locale}
      baseCurrency={user.baseCurrency}
      rows={rows}
      options={options}
      balances={balances.filter((a) => !a.closed).map((a) => ({ id: a.id, name: a.name, currency: a.currency, balance: a.balance }))}
      filters={{ from: s("from"), to: s("to"), type: s("type"), status: s("status"), account: s("account"), dept: s("dept"), category: s("category"), q: s("q") }}
      perms={{ create: can(user, "journal:create"), post: can(user, "journal:post"), paySalary: can(user, "payroll:pay") }}
      salaryPayments={salaryPayments}
    />
  )
}
