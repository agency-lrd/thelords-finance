import type { Metadata } from "next"
import { Suspense } from "react"

import { PageSkeleton } from "@/components/shared/page-skeleton"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listCategoryTree } from "@/lib/data/categories"
import { getSheet } from "@/lib/data/sheet"
import { listSheetDepartments } from "@/lib/data/sheet-admin"
import { prisma } from "@/lib/db"
import { getDictionary } from "@/lib/i18n/server"
import { currentMonth, monthKey } from "@/lib/period"

import { StructureView } from "./structure-view"
import { TeamsManager } from "./teams-manager"

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
  const [departments, categories, teams, sheet] = await Promise.all([
    listSheetDepartments(user, month),
    can(user, "ledger:read") ? listCategoryTree(user) : null,
    prisma.team.findMany({
      where: { archivedAt: null, department: { organizationId: user.organizationId, archivedAt: null } },
      include: { department: { select: { name: true } } },
      orderBy: [{ department: { sortOrder: "asc" } }, { sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    can(user, "payroll:read") ? getSheet(user, month) : null,
  ])
  return (
    <>
    <StructureView
      locale={locale}
      monthKey={monthKey(month)}
      departments={departments.map((d) => ({ id: d.id, name: d.name, archived: d.archived }))}
      categories={categories ? categories.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId, archived: c.archived })) : null}
      perms={{ departments: can(user, "structure:manage"), categories: can(user, "ledger:manage") }}
    />
    <div className="mt-6">
      <TeamsManager
        locale={locale}
        monthKey={monthKey(month)}
        departments={departments.filter((d) => !d.archived).map((d) => ({ id: d.id, name: d.name }))}
        teams={teams.map((x) => ({ id: x.id, name: x.name, departmentId: x.departmentId, departmentName: x.department.name }))}
        employees={sheet ? sheet.rows.map((r) => ({ employeeId: r.employeeId, name: r.name, departmentId: r.departmentId, teamId: r.teamId })) : null}
        canManage={can(user, "project_finance:manage")}
        canAssign={can(user, "project_finance:manage") && sheet !== null && sheet.editable}
      />
    </div>
    </>
  )
}
