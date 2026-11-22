"use client"

import { AlertTriangle, ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/form-controls"
import type { SheetRow } from "@/lib/data/sheet"
import type { Locale } from "@/lib/i18n/format"

import { updateCellAction } from "./actions"

const T = {
  ru: {
    title: "Нужно распределить по основным отделам: {n}",
    hint: "С ноября 2026 в Финлисте четыре отдела: Influence, AI Production, Crypto Marketing, Traffic Affiliate. Эти сотрудники в этом месяце ещё числятся в старых отделах. Выберите отдел для каждого — перевод действует с этого месяца, октябрь и ранее не меняются. Автоматически ничего не переносится.",
    show: "Показать",
    hide: "Скрыть",
    oldDepartment: "Старый отдел",
    choose: "Выберите отдел…",
    assign: "Перевести",
    assignAll: "Перевести всех из «{dept}»",
    noDepartment: "Без отдела",
    done: "{name}: переведён в {dept} с этого месяца",
  },
  en: {
    title: "To assign to a main department: {n}",
    hint: "From November 2026 the sheet has four departments: Influence, AI Production, Crypto Marketing, Traffic Affiliate. These employees are still in old departments this month. Choose a department for each: it applies from this month; October and earlier do not change. Nothing is moved automatically.",
    show: "Show",
    hide: "Hide",
    oldDepartment: "Old department",
    choose: "Choose department…",
    assign: "Move",
    assignAll: "Move everyone from “{dept}”",
    noDepartment: "No department",
    done: "{name}: moved to {dept} from this month",
  },
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""))

/** Employees still in old departments this month, assigned explicitly (one by one or per old department). */
export function LegacyAssignment(props: { locale: Locale; monthKey: string; rows: SheetRow[]; mainDepartments: { id: string; name: string }[]; canEdit: boolean; toast: (text: string, tone?: "ok" | "error") => void }) {
  const t = T[props.locale]
  const [open, setOpen] = useState(true)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  // Confirmed transfers leave the list at once; the fresh sheet arrives with the same server response.
  const [moved, setMoved] = useState<Set<string>>(new Set())
  const pending = props.rows.filter((r) => !moved.has(r.employeeId))
  const groups = new Map<string, { name: string; rows: SheetRow[] }>()
  for (const r of pending) {
    const key = r.departmentId ?? "none"
    const g = groups.get(key) ?? { name: r.departmentName ?? t.noDepartment, rows: [] }
    g.rows.push(r)
    groups.set(key, g)
  }
  const nameOf = (id: string) => props.mainDepartments.find((d) => d.id === id)?.name ?? ""

  async function move(list: SheetRow[], departmentId: string, key: string) {
    if (busy) return
    setBusy(key)
    for (const r of list) {
      const result = await updateCellAction(props.monthKey, r.employeeId, "department", departmentId, r.departmentId ?? "").catch(() => ({ ok: false as const, message: props.locale === "ru" ? "Соединение прервано — перевод не сохранён" : "Connection lost: not saved" }))
      if (!result.ok) {
        setBusy(null)
        // The employee stays in the list: nothing changed on the server.
        return props.toast(`${r.name}: ${result.message}`, "error")
      }
      setMoved((m) => new Set(m).add(r.employeeId))
      props.toast(fill(t.done, { name: r.name, dept: nameOf(departmentId) }))
    }
    setBusy(null)
  }

  if (pending.length === 0) return null

  return (
    <section className="rounded-2xl border border-amber-400/40 bg-amber-400/5 px-4 py-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left text-sm font-semibold text-amber-200">
        <AlertTriangle className="size-4 shrink-0" /> {fill(t.title, { n: pending.length })}
        <span className="ml-auto flex items-center gap-1 text-xs font-normal text-muted-foreground">{open ? t.hide : t.show} {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t.hint}</p>
          {[...groups.entries()].map(([key, g]) => (
            <div key={key} className="rounded-xl border border-border/60 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{t.oldDepartment}:</span> <span className="font-semibold">{g.name}</span>
                {props.canEdit && g.rows.length > 1 && (
                  <span className="ml-auto flex items-center gap-2">
                    <Select value={choice[`all-${key}`] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [`all-${key}`]: e.target.value }))} className="h-7 w-48 text-xs" aria-label={t.choose}>
                      <option value="">{t.choose}</option>
                      {props.mainDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    <Button size="sm" variant="outline" disabled={!choice[`all-${key}`] || !!busy} onClick={() => move(g.rows, choice[`all-${key}`], `all-${key}`)}>
                      {busy === `all-${key}` && <Loader2 className="animate-spin" />} {fill(t.assignAll, { dept: g.name })}
                    </Button>
                  </span>
                )}
              </div>
              <ul className="flex flex-col divide-y divide-border/40 text-sm">
                {g.rows.map((r) => (
                  <li key={r.employeeId} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="min-w-40 flex-1">{r.name}{r.positionName && <span className="ml-2 text-[11px] text-muted-foreground">{r.positionName}</span>}</span>
                    {props.canEdit && (
                      <>
                        <Select value={choice[r.employeeId] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [r.employeeId]: e.target.value }))} className="h-7 w-48 text-xs" aria-label={t.choose}>
                          <option value="">{t.choose}</option>
                          {props.mainDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </Select>
                        <Button size="sm" variant="outline" disabled={!choice[r.employeeId] || !!busy} onClick={() => move([r], choice[r.employeeId], r.employeeId)}>
                          {busy === r.employeeId && <Loader2 className="animate-spin" />} {t.assign}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
