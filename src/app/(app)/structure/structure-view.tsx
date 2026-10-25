"use client"

import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { Locale } from "@/lib/i18n/format"

import { createCategoryAction, updateCategoryAction } from "../categories/actions"
import { archiveDepartmentAction, createDepartmentAction, moveCategoryAction, moveDepartmentAction, renameDepartmentAction } from "../payroll/actions"

type Department = { id: string; name: string; archived: boolean }
type Category = { id: string; name: string; kind: string; parentId: string | null; archived: boolean }

const GROUPS = [
  { key: "income", kinds: ["REVENUE", "OTHER_INCOME"], create: "REVENUE" },
  { key: "direct", kinds: ["COST_OF_SALES"], create: "COST_OF_SALES" },
  { key: "operating", kinds: ["OPERATING_EXPENSE"], create: "OPERATING_EXPENSE" },
  { key: "other", kinds: ["OTHER_EXPENSE", "DEPRECIATION", "AMORTIZATION", "INTEREST", "TAX"], create: "OTHER_EXPENSE" },
] as const

const T = {
  ru: {
    title: "Отделы и категории",
    description: "Слева — отделы компании, справа — категории доходов и расходов. Переименование не меняет историю: все записи связаны по постоянному идентификатору. Удаление не используется — архив можно восстановить.",
    departments: "Отделы",
    categories: "Категории",
    groups: { income: "Доходы", direct: "Прямые расходы на проекты", operating: "Операционные расходы", other: "Прочие расходы" },
    add: "Добавить",
    name: "Название",
    rename: "Переименовать",
    archive: "В архив",
    restore: "Восстановить",
    archived: "Архив",
    up: "Выше",
    down: "Ниже",
    deptType: "Тип отдела",
    delivery: "Проектный (прямые расходы)",
    overhead: "Административный",
    group: "Группа",
    advanced: "Расширенные настройки: подотделы, команды, строки P&L →",
    noAccess: "Нет доступа к категориям.",
  },
  en: {
    title: "Departments and categories",
    description: "Departments on the left, income and expense categories on the right. Renaming never changes history: records are linked by a permanent id. Nothing is deleted: archived items can be restored.",
    departments: "Departments",
    categories: "Categories",
    groups: { income: "Income", direct: "Direct project costs", operating: "Operating expenses", other: "Other expenses" },
    add: "Add",
    name: "Name",
    rename: "Rename",
    archive: "Archive",
    restore: "Restore",
    archived: "Archived",
    up: "Up",
    down: "Down",
    deptType: "Department type",
    delivery: "Delivery (direct costs)",
    overhead: "Overhead",
    group: "Group",
    advanced: "Advanced: sub-departments, teams, P&L lines →",
    noAccess: "No access to categories.",
  },
}

export function StructureView(props: { locale: Locale; monthKey: string; departments: Department[]; categories: Category[] | null; perms: { departments: boolean; categories: boolean } }) {
  const t = T[props.locale]
  const router = useRouter()
  const [, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [dept, setDept] = useState({ name: "", type: "COST_OF_SALES" })
  const [cat, setCat] = useState({ name: "", kind: "COST_OF_SALES" })
  const [showArchived, setShowArchived] = useState(false)

  async function run(key: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!r.ok) {
      setError(r.message ?? "Error")
      return false
    }
    setError(null)
    start(() => router.refresh())
    return true
  }

  const row = (item: { id: string; name: string; archived: boolean }, can: boolean, ops: { rename: (name: string) => Promise<{ ok: boolean; message?: string }>; archive: (archived: boolean) => Promise<{ ok: boolean; message?: string }>; move?: (d: "up" | "down") => Promise<{ ok: boolean; message?: string }> }, first: boolean, last: boolean, indent = false) => (
    <li key={item.id} className={cn("group flex items-center gap-2 border-t border-border/40 py-2 text-sm first:border-0", indent && "pl-5", item.archived && "text-muted-foreground")}>
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {can && (
        <span className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
          {!item.archived && ops.move && (
            <>
              <button type="button" disabled={first} title={t.up} aria-label={t.up} className="rounded p-1 hover:text-primary disabled:opacity-30" onClick={() => run(item.id, () => ops.move!("up"))}><ArrowUp className="size-3.5" /></button>
              <button type="button" disabled={last} title={t.down} aria-label={t.down} className="rounded p-1 hover:text-primary disabled:opacity-30" onClick={() => run(item.id, () => ops.move!("down"))}><ArrowDown className="size-3.5" /></button>
            </>
          )}
          <button type="button" title={t.rename} aria-label={t.rename} className="rounded p-1 hover:text-primary" onClick={() => { const name = window.prompt(t.name, item.name); if (name && name.trim() && name.trim() !== item.name) run(item.id, () => ops.rename(name.trim())) }}><Pencil className="size-3.5" /></button>
          <button type="button" title={item.archived ? t.restore : t.archive} aria-label={item.archived ? t.restore : t.archive} className="rounded p-1 hover:text-primary" onClick={() => run(item.id, () => ops.archive(!item.archived))}>{item.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}</button>
        </span>
      )}
    </li>
  )

  const activeDepts = props.departments.filter((d) => !d.archived)
  const archivedDepts = props.departments.filter((d) => d.archived)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{t.title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-[var(--primary)]" /> {t.archived}</label>
      </div>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">{error}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Departments */}
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.departments}</h2>
          <ul>
            {activeDepts.map((d, i) => row(d, props.perms.departments, { rename: (name) => renameDepartmentAction(d.id, name), archive: (a) => archiveDepartmentAction(d.id, a, props.monthKey), move: (dir) => moveDepartmentAction(d.id, dir) }, i === 0, i === activeDepts.length - 1))}
            {showArchived && archivedDepts.map((d) => row(d, props.perms.departments, { rename: (name) => renameDepartmentAction(d.id, name), archive: (a) => archiveDepartmentAction(d.id, a, props.monthKey) }, true, true))}
          </ul>
          {props.perms.departments && (
            <form className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-3" onSubmit={async (e) => { e.preventDefault(); if (await run("dept", () => createDepartmentAction({ name: dept.name, color: null, costClassification: dept.type }))) setDept({ ...dept, name: "" }) }}>
              <Input value={dept.name} onChange={(e) => setDept({ ...dept, name: e.target.value })} placeholder={t.name} maxLength={80} className="h-8 w-48" aria-label={t.name} />
              <Select value={dept.type} onChange={(e) => setDept({ ...dept, type: e.target.value })} className="h-8 w-56" aria-label={t.deptType}>
                <option value="COST_OF_SALES">{t.delivery}</option>
                <option value="OPERATING_EXPENSE">{t.overhead}</option>
              </Select>
              <Button size="sm" type="submit" disabled={!dept.name.trim() || busy === "dept"}><Plus /> {t.add}</Button>
            </form>
          )}
        </section>

        {/* Categories */}
        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.categories}</h2>
          {!props.categories ? (
            <p className="text-sm text-muted-foreground">{t.noAccess}</p>
          ) : (
            GROUPS.map((g) => {
              const items = props.categories!.filter((c) => (g.kinds as readonly string[]).includes(c.kind) && (showArchived || !c.archived))
              if (!items.length) return null
              return (
                <div key={g.key}>
                  <p className="mt-2 mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{t.groups[g.key]}</p>
                  <ul>
                    {items.map((c, i) => {
                      const siblings = items.filter((x) => x.kind === c.kind && x.parentId === c.parentId && !x.archived)
                      const pos = siblings.findIndex((x) => x.id === c.id)
                      return row(c, props.perms.categories, { rename: (name) => updateCategoryAction(c.id, { name }), archive: (a) => updateCategoryAction(c.id, { archived: a }), move: (dir) => moveCategoryAction(c.id, dir) }, pos <= 0, pos === siblings.length - 1 || i === items.length - 1, !!c.parentId)
                    })}
                  </ul>
                </div>
              )
            })
          )}
          {props.perms.categories && (
            <form className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-3" onSubmit={async (e) => { e.preventDefault(); if (await run("cat", () => createCategoryAction({ name: cat.name, kind: cat.kind, parentId: "", ledgerAccountId: "" }))) setCat({ ...cat, name: "" }) }}>
              <Input value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} placeholder={t.name} maxLength={120} className="h-8 w-48" aria-label={t.name} />
              <Select value={cat.kind} onChange={(e) => setCat({ ...cat, kind: e.target.value })} className="h-8 w-56" aria-label={t.group}>
                <option value="REVENUE">{t.groups.income}</option>
                <option value="COST_OF_SALES">{t.groups.direct}</option>
                <option value="OPERATING_EXPENSE">{t.groups.operating}</option>
                <option value="OTHER_EXPENSE">{t.groups.other}</option>
              </Select>
              <Button size="sm" type="submit" disabled={!cat.name.trim() || busy === "cat"}><Plus /> {t.add}</Button>
            </form>
          )}
        </section>
      </div>
      <div className="flex flex-wrap gap-4 text-xs">
        <Link href="/departments" className="text-primary hover:underline">{t.advanced}</Link>
      </div>
    </div>
  )
}
