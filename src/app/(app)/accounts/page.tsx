import { Landmark } from "lucide-react"
import type { Metadata } from "next"
import { Suspense } from "react"

import { ActionForm } from "@/components/shared/action-form"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { Input, Select } from "@/components/ui/form-controls"
import { can, requirePageAccess } from "@/lib/auth/session"
import { ACCOUNT_TYPES, listFinancialAccounts } from "@/lib/data/accounts"
import { formatAmount } from "@/lib/i18n/format"
import { getDictionary } from "@/lib/i18n/server"
import { SUPPORTED_CURRENCIES } from "@/lib/money"

import { createAccountAction } from "./actions"

export const metadata: Metadata = { title: "Счета" }

export default function AccountsPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Счета" />}>
      <Accounts />
    </Suspense>
  )
}

async function Accounts() {
  const user = await requirePageAccess("ledger:read")
  const { t, locale } = await getDictionary()
  const accounts = await listFinancialAccounts(user)
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t.accounts.title} description={t.accounts.description} />
      {accounts.length === 0 ? (
        <EmptyState icon={Landmark} title={t.accounts.empty} description={t.accounts.description} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
            <div key={a.id} className="flex flex-col gap-3 rounded-3xl border border-border bg-card/60 p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-display text-lg font-black uppercase italic">{a.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.accounts.types[a.type]} · {a.currency}{a.institution ? ` · ${a.institution}` : ""} · {a.code}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{t.accounts.balance} ({user.baseCurrency})</p>
                <p className="font-display text-2xl font-black">{formatAmount(a.balance, user.baseCurrency, locale)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {can(user, "ledger:manage") && (
        <section className="rounded-3xl border border-dashed border-border bg-card/30 p-6">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.accounts.add}</p>
          <ActionForm action={createAccountAction} submitLabel={t.common.add}>
            <div className="grid gap-3 sm:grid-cols-4">
              <Input name="name" placeholder={t.accounts.name} required maxLength={120} aria-label={t.accounts.name} />
              <Select name="type" defaultValue="CRYPTO_WALLET" aria-label={t.accounts.type}>
                {ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{t.accounts.types[type]}</option>)}
              </Select>
              <Select name="currency" defaultValue="USDT" aria-label={t.accounts.currency}>
                {SUPPORTED_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </Select>
              <Input name="institution" placeholder={t.accounts.institution} maxLength={120} aria-label={t.accounts.institution} />
            </div>
          </ActionForm>
        </section>
      )}
    </div>
  )
}
