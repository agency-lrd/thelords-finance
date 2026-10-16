import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listCategoryTree } from "@/lib/data/categories"
import { getDictionary } from "@/lib/i18n/server"

import { CategoriesView } from "./categories-view"

export const metadata: Metadata = { title: "Категории" }

export default function CategoriesPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Категории" />}>
      <Categories />
    </Suspense>
  )
}

async function Categories() {
  const user = await requirePageAccess("ledger:read")
  const { locale } = await getDictionary()
  return <CategoriesView locale={locale} data={await listCategoryTree(user)} canEdit={can(user, "ledger:manage")} />
}
