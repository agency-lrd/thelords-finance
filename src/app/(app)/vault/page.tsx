import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requireUser } from "@/lib/auth/session"
import { ACCESS_LEVELS, listCredentials, listVaultCategories, shareCandidates } from "@/lib/data/vault"
import { credentialsWithSecret } from "@/lib/data/vault-secrets"
import { vaultConfigured } from "@/lib/vault/secrets"
import { getDictionary } from "@/lib/i18n/server"
import { prisma } from "@/lib/db"

import { VaultView } from "./vault-view"

export const metadata: Metadata = { title: "Пароли" }

export default function VaultPage({ searchParams }: PageProps<"/vault">) {
  return (
    <Suspense fallback={<PageSkeleton title="Пароли" />}>
      <Vault searchParams={searchParams} />
    </Suspense>
  )
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function Vault({ searchParams }: { searchParams: PageProps<"/vault">["searchParams"] }) {
  // Any signed-in member may open the page; the data layer shows only what is shared with them.
  const user = await requireUser()
  const { locale } = await getDictionary()
  const p = await searchParams
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "")
  const filters = {
    search: s("q").slice(0, 100) || null,
    departmentId: s("dept") === "none" ? "none" : UUID.test(s("dept")) ? s("dept") : null,
    categoryId: UUID.test(s("cat")) ? s("cat") : null,
    accessLevel: ACCESS_LEVELS.find((l) => l === s("level")) ?? null,
    archived: s("archived") === "1",
  }
  const manage = can(user, "vault:manage")
  const [rows, categories, departments, candidates, secrets] = await Promise.all([
    listCredentials(user, filters),
    listVaultCategories(user),
    prisma.department.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    shareCandidates(user),
    credentialsWithSecret(user),
  ])
  return (
    <VaultView
      locale={locale}
      rows={rows}
      categories={categories}
      departments={departments}
      candidates={candidates}
      filters={{ q: s("q"), dept: s("dept"), cat: s("cat"), level: s("level"), archived: s("archived") }}
      perms={{ manage, audit: can(user, "vault:audit") }}
      secrets={{ configured: vaultConfigured(), superAdmin: user.isSuperAdmin, ids: secrets.map((x) => x.credentialId) }}
    />
  )
}
