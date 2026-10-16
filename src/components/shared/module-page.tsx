import { Suspense } from "react"

import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { getNavItem } from "@/config/navigation"
import { requireUser } from "@/lib/auth/session"
import { getDictionary } from "@/lib/i18n/server"

/** Placeholder for modules scheduled for later phases. Still requires sign-in. */
export function ModulePage({ href }: { href: string }) {
  return (
    <Suspense>
      <Placeholder href={href} />
    </Suspense>
  )
}

async function Placeholder({ href }: { href: string }) {
  await requireUser()
  const { t } = await getDictionary()
  const item = getNavItem(href)
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t.nav[item.key]} description={t.module.soonText} />
      <EmptyState icon={item.icon} title={t.module.soon} description={t.module.soonText} />
    </div>
  )
}
