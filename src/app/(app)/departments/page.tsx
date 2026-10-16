import type { Metadata } from "next"
import { Suspense } from "react"
import { cn } from "cn"

import { ActionForm } from "@/components/shared/action-form"
import { PageHeader } from "@/components/shared/page-header"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { Input, Select } from "@/components/ui/form-controls"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listDepartmentTree } from "@/lib/data/departments"
import { getSheet } from "@/lib/data/sheet"
import { formatAmount } from "@/lib/i18n/format"
import { getDictionary } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { currentMonth } from "@/lib/period"
import { prisma } from "@/lib/db"

import { archiveDepartmentAction, createDepartmentAction, createTeamAction, updateDepartmentAction, updateTeamAction } from "./actions"

export const metadata: Metadata = { title: "Отделы" }

export default function DepartmentsPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Отделы" />}>
      <Departments />
    </Suspense>
  )
}

async function Departments() {
  const user = await requirePageAccess("structure:read")
  const { t, locale } = await getDictionary()
  const month = currentMonth()
  const [tree, employees, sheet] = await Promise.all([
    listDepartmentTree(user, month),
    prisma.employee.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, select: { id: true, firstName: true, lastName: true }, orderBy: { firstName: "asc" } }),
    can(user, "payroll:read") && can(user, "salary:read") ? getSheet(user, month) : null,
  ])
  const manage = can(user, "structure:manage")
  const payroll = new Map<string, Decimal>()
  for (const r of sheet?.rows ?? []) {
    if (r.departmentId && r.currency === user.baseCurrency) payroll.set(r.departmentId, (payroll.get(r.departmentId) ?? new Decimal(0)).add(r.calculated))
  }
  const active = tree.filter((d) => !d.archived)
  const archived = tree.filter((d) => d.archived)
  const byParent = (parentId: string | null) => active.filter((d) => d.parentId === parentId)
  const ordered: { d: (typeof tree)[number]; depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => byParent(parentId).forEach((d) => (ordered.push({ d, depth }), walk(d.id, depth + 1)))
  walk(null, 0)
  // Departments whose parent is archived would otherwise disappear: list them at the top level.
  active.filter((d) => d.parentId && !active.some((p) => p.id === d.parentId)).forEach((d) => (ordered.push({ d, depth: 0 }), walk(d.id, 1)))

  const employeeOptions = employees.map((e) => (
    <option key={e.id} value={e.id}>{`${e.firstName} ${e.lastName}`.trim()}</option>
  ))

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t.departments.title} description={t.departments.description} />

      <div className="grid gap-4 lg:grid-cols-2">
        {ordered.map(({ d, depth }) => (
          <section key={d.id} className={cn("flex flex-col gap-4 rounded-3xl border border-border bg-card/60 p-6", depth > 0 && "border-l-4 border-l-primary/50")} style={{ marginLeft: depth ? Math.min(depth, 3) * 16 : 0 }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-black uppercase italic">{d.name}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.costClassification === "COST_OF_SALES" ? t.departments.cogs : t.departments.opex}
                  {d.head && ` · ${t.departments.head}: ${d.head.name}`}
                </p>
              </div>
              <div className="text-right">
                <p className="font-display text-2xl font-black">{d.headcount}</p>
                <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t.departments.headcount}</p>
              </div>
            </div>
            {sheet && (
              <p className="text-sm text-muted-foreground">
                {t.departments.payroll}: <span className="font-mono text-foreground">{formatAmount((payroll.get(d.id) ?? new Decimal(0)).toString(), user.baseCurrency, locale)}</span>
              </p>
            )}

            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">{t.departments.teams}</p>
              {d.teams.filter((x) => !x.archived).length === 0 && <p className="text-sm text-muted-foreground">{t.departments.emptyTeams}</p>}
              {d.teams.filter((x) => !x.archived).map((team) => (
                <div key={team.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2 text-sm">
                  <span className="font-medium">{team.name}</span>
                  {manage ? (
                    <ActionForm action={updateTeamAction.bind(null, team.id)} submitLabel={t.common.save} size="xs" variant="outline" resetOnSuccess={false} className="flex-row items-center gap-2">
                      <Select name="leadEmployeeId" defaultValue={team.lead?.id ?? ""} className="h-7 w-44 text-xs" aria-label={t.departments.teamLead}>
                        <option value="">{t.departments.teamLead}: —</option>
                        {employeeOptions}
                      </Select>
                    </ActionForm>
                  ) : (
                    <span className="text-muted-foreground">{team.lead?.name ?? "—"}</span>
                  )}
                </div>
              ))}
            </div>

            {manage && (
              <details className="group rounded-xl border border-border/60 px-4 py-3">
                <summary className="cursor-pointer text-sm text-muted-foreground select-none group-open:text-foreground">{t.departments.rename} · {t.departments.addTeam}</summary>
                <div className="mt-4 flex flex-col gap-5">
                  <ActionForm action={updateDepartmentAction.bind(null, d.id)} submitLabel={t.common.save} size="sm" resetOnSuccess={false}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input name="name" defaultValue={d.name} required maxLength={120} aria-label={t.departments.name} />
                      <Select name="costClassification" defaultValue={d.costClassification} aria-label={t.departments.classification}>
                        <option value="COST_OF_SALES">{t.departments.cogs}</option>
                        <option value="OPERATING_EXPENSE">{t.departments.opex}</option>
                      </Select>
                      <Select name="parentId" defaultValue={d.parentId ?? ""} aria-label={t.departments.parent}>
                        <option value="">{t.departments.parent}: —</option>
                        {active.filter((p) => p.id !== d.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                      <Select name="headEmployeeId" defaultValue={d.head?.id ?? ""} aria-label={t.departments.head}>
                        <option value="">{t.departments.head}: —</option>
                        {employeeOptions}
                      </Select>
                    </div>
                  </ActionForm>
                  <ActionForm action={createTeamAction.bind(null, d.id)} submitLabel={t.departments.addTeam} size="sm" variant="outline">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input name="name" placeholder={t.departments.teamName} required maxLength={120} aria-label={t.departments.teamName} />
                      <Select name="leadEmployeeId" defaultValue="" aria-label={t.departments.teamLead}>
                        <option value="">{t.departments.teamLead}: —</option>
                        {employeeOptions}
                      </Select>
                    </div>
                  </ActionForm>
                  <ActionForm action={archiveDepartmentAction.bind(null, d.id, true)} submitLabel={t.common.archive} size="sm" variant="ghost" confirm={`${t.common.archive}: ${d.name}?`} />
                </div>
              </details>
            )}
          </section>
        ))}
      </div>

      {manage && (
        <section className="rounded-3xl border border-dashed border-border bg-card/30 p-6">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.departments.add}</p>
          <ActionForm action={createDepartmentAction} submitLabel={t.common.add}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input name="name" placeholder={t.departments.name} required maxLength={120} aria-label={t.departments.name} />
              <Select name="parentId" defaultValue="" aria-label={t.departments.parent}>
                <option value="">{t.departments.parent}: —</option>
                {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              <Select name="costClassification" defaultValue="OPERATING_EXPENSE" aria-label={t.departments.classification}>
                <option value="COST_OF_SALES">{t.departments.cogs}</option>
                <option value="OPERATING_EXPENSE">{t.departments.opex}</option>
              </Select>
            </div>
          </ActionForm>
        </section>
      )}

      {archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.departments.archived}</p>
          {archived.map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-xl border border-border/60 px-4 py-2 text-sm text-muted-foreground">
              {d.name}
              {manage && <ActionForm action={archiveDepartmentAction.bind(null, d.id, false)} submitLabel={t.common.restore} size="xs" variant="outline" />}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
