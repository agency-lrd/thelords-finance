import { getNavItem } from "@/config/navigation"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"

/** Placeholder layout for modules whose data layer is not wired up yet. */
export function ModulePage({ href }: { href: string }) {
  const item = getNavItem(href)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={item.title} description={item.description} />
      <EmptyState
        icon={item.icon}
        title={`No ${item.title} data yet`}
        description="This module will populate once a data source is connected. Nothing is shown until real records exist."
      />
    </div>
  )
}
