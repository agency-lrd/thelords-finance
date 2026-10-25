import Link from "next/link"

import type { SessionUser } from "@/lib/auth/session"
import { plansWithActuals } from "@/lib/data/plans"
import type { Locale } from "@/lib/i18n/format"

import { PlansView } from "./plans-view"

/** Plans for the selected month with plan / actual / variance (server part). */
export async function PlansPanel({ user, locale, month, canEdit }: { user: SessionUser; locale: Locale; month: { year: number; month: number }; canEdit: boolean }) {
  const plans = await plansWithActuals(user, month)
  const key = `${month.year}-${String(month.month).padStart(2, "0")}`
  return (
    <section id="plans" className="flex flex-col gap-3">
      <PlansView locale={locale} monthKey={key} currency={user.baseCurrency} plans={plans} canEdit={canEdit} />
      <Link href="/budgets" className="text-xs text-primary hover:underline">{locale === "ru" ? "Детальный бюджет по статьям и сценариям →" : "Detailed budget by line and scenario →"}</Link>
    </section>
  )
}
