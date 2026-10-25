import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listCategoryTree } from "@/lib/data/categories"
import { listSheetDepartments } from "@/lib/data/sheet-admin"
import { getDictionary } from "@/lib/i18n/server"
import { currentMonth, monthKey } from "@/lib/period"

import { StructureView } from "./structure-view"

export const metadata: Metadata = { title: "Отделы и категории" }

export default function StructurePage() {
  return (
    <Suspense fallback={<PageSkeleton title="Отделы и категории" />}>
      <Structure />
    </Suspense>
  )
}

async function Structure() {
  const user = await requirePageAccess("structure:read")
  const { locale } = await getDictionary()
  const month = currentMonth()
  const [departments, categories] = await Promise.all([listSheetDepartments(user, month), can(user, "ledger:read") ? listCategoryTree(user) : null])
  return (
    <StructureView
      locale={locale}
      monthKey={monthKey(month)}
      departments={departments.map((d) => ({ id: d.id, name: d.name, archived: d.archived }))}
      categories={categories ? categories.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId, archived: c.archived })) : null}
      perms={{ departments: can(user, "structure:manage"), categories: can(user, "ledger:manage") }}
    />
  )
}
