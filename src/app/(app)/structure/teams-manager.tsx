"use client"

import { Archive, ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { Locale } from "@/lib/i18n/format"

import { createTeamAction, setEmployeeTeamAction, updateTeamAction } from "../payroll/actions"

type Team = { id: string; name: string; departmentId: string; departmentName: string }
type Employee = { employeeId: string; name: string; departmentId: string | null; teamId: string | null }

const T = {
  ru: {
    title: "Команды",
    hint: "Команды внутри отделов (например, «Команда Саня» в Influence). Сотрудники назначаются в команду с текущего месяца; прошлые месяцы не меняются. Доходы, расходы и прибыль команд — в разделе «Аналитика».",
    name: "Название команды",
    department: "Отдел",
    add: "Добавить",
    rename: "Переименовать",
    archive: "В архив",
    up: "Выше",
    down: "Ниже",
    addMember: "+ сотрудник",
    none: "Команд пока нет.",
  },
  en: {
    title: "Teams",
    hint: "Teams inside departments (e.g. “Team Sanya” in Influence). Employees join a team from the current month; earlier months do not change. Team income, costs and profit are in Analytics.",
    name: "Team name",
    department: "Department",
    add: "Add",
    rename: "Rename",
    archive: "Archive",
    up: "Up",
    down: "Down",
    addMember: "+ employee",
    none: "No teams yet.",
  },
}

/** Team management on the structure screen: create, rename, reorder, archive and assign employees. */
export function TeamsManager(props: { locale: Locale; monthKey: string; departments: { id: string; name: string }[]; teams: Team[]; employees: Employee[] | null; canManage: boolean; canAssign: boolean }) {
  const t = T[props.locale]
  const router = useRouter()
  const [, start] = useTransition()
  const [name, setName] = useState("")
  const [departmentId, setDepartmentId] = useState(props.departments.find((d) => /influ/i.test(d.name))?.id ?? props.departments[0]?.id ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function run(key: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!r.ok) return setError(r.message ?? "Error")
    setError(null)
    start(() => router.refresh())
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-5">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t.hint}</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {props.teams.length === 0 && <p className="text-sm text-muted-foreground">{t.none}</p>}
      <ul>
        {props.teams.map((team) => {
          const siblings = props.teams.filter((x) => x.departmentId === team.departmentId)
          const index = siblings.findIndex((x) => x.id === team.id)
          const members = props.employees?.filter((e) => e.teamId === team.id) ?? []
          const candidates = props.employees?.filter((e) => e.departmentId === team.departmentId && e.teamId !== team.id) ?? []
          return (
            <li key={team.id} className="group flex flex-wrap items-center gap-2 border-t border-border/40 py-2 text-sm first:border-0">
              <span className="min-w-40 flex-1">
                {team.name} <span className="text-[11px] text-muted-foreground">· {team.departmentName}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1 text-xs">
                {members.map((m) => (
                  <span key={m.employeeId} className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5">
                    {m.name}
                    {props.canAssign && <button type="button" aria-label="×" className="text-muted-foreground hover:text-red-300" onClick={() => run(m.employeeId, () => setEmployeeTeamAction(props.monthKey, m.employeeId, null))}>×</button>}
                  </span>
                ))}
                {props.canAssign && candidates.length > 0 && (
                  <Select value="" onChange={(e) => e.target.value && run(e.target.value, () => setEmployeeTeamAction(props.monthKey, e.target.value, team.id))} className="h-7 w-36 text-xs" aria-label={t.addMember}>
                    <option value="">{t.addMember}</option>
                    {candidates.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.name}</option>)}
                  </Select>
                )}
              </span>
              {props.canManage && (
                <span className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                  <button type="button" disabled={index === 0} title={t.up} aria-label={t.up} className="rounded p-1 hover:text-primary disabled:opacity-30" onClick={() => run(team.id, () => updateTeamAction(team.id, { move: "up" }))}><ArrowUp className="size-3.5" /></button>
                  <button type="button" disabled={index === siblings.length - 1} title={t.down} aria-label={t.down} className="rounded p-1 hover:text-primary disabled:opacity-30" onClick={() => run(team.id, () => updateTeamAction(team.id, { move: "down" }))}><ArrowDown className="size-3.5" /></button>
                  <button type="button" title={t.rename} aria-label={t.rename} className="rounded p-1 hover:text-primary" onClick={() => { const next = window.prompt(t.name, team.name); if (next && next.trim() && next.trim() !== team.name) run(team.id, () => updateTeamAction(team.id, { name: next.trim() })) }}><Pencil className="size-3.5" /></button>
                  <button type="button" title={t.archive} aria-label={t.archive} className="rounded p-1 hover:text-red-300" onClick={() => window.confirm(`${t.archive}: ${team.name}?`) && run(team.id, () => updateTeamAction(team.id, { archived: true }))}><Archive className="size-3.5" /></button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {props.canManage && (
        <form className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && departmentId) run("add", () => createTeamAction(departmentId, name)).then(() => setName("")) }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.name} maxLength={80} className="h-8 w-48" aria-label={t.name} />
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-8 w-48" aria-label={t.department}>{props.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          <Button size="sm" type="submit" disabled={!name.trim() || busy === "add"}><Plus /> {t.add}</Button>
        </form>
      )}
    </section>
  )
}
