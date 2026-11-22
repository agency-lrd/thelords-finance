"use client"

import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Loader2, Pencil, Plus } from "lucide-react"
import { useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/form-controls"
import type { SheetAdminTexts } from "@/lib/i18n/sheet-admin"

import { createPositionAction, updatePositionAction } from "./actions"
import { Panel } from "./sheet-admin"

type Position = { id: string; name: string; nameRu: string | null; sortOrder: number; archived: boolean; employees: number }

/** The position directory: add, rename (also Russian name), reorder, archive and restore. */
export function PositionsManager(props: { t: SheetAdminTexts; positions: Position[]; canManage: boolean; onChanged: () => void; onClose: () => void }) {
  const P = props.t.positions
  const [name, setName] = useState("")
  const [nameRu, setNameRu] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const active = props.positions.filter((p) => !p.archived)
  const archived = props.positions.filter((p) => p.archived)

  async function run(key: string, fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(key)
    const r = await fn()
    setBusy(null)
    if (!r.ok) {
      setError(r.message ?? "Error")
      return false
    }
    setError(null)
    props.onChanged()
    return true
  }

  const row = (p: Position, index: number, list: Position[]) => (
    <li key={p.id} className={cn("group flex items-center gap-2 border-t border-border/40 py-1.5 text-sm first:border-0", p.archived && "text-muted-foreground")}>
      <span className="w-6 text-right font-mono text-[11px] text-muted-foreground">{p.archived ? "–" : index + 1}</span>
      <span className="min-w-0 flex-1 truncate">
        {p.name}
        {p.nameRu && <span className="ml-2 text-[11px] text-muted-foreground">{p.nameRu}</span>}
        {p.employees > 0 && <span className="ml-2 text-[10px] text-muted-foreground/70">{p.employees} {P.employees}</span>}
      </span>
      {props.canManage && (
        <span className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
          {!p.archived && (
            <>
              <button type="button" disabled={index === 0 || !!busy} title={P.up} aria-label={P.up} className="rounded p-1 hover:text-primary disabled:opacity-30" onClick={() => run(p.id, () => updatePositionAction(p.id, { move: "up" }))}><ArrowUp className="size-3.5" /></button>
              <button type="button" disabled={index === list.length - 1 || !!busy} title={P.down} aria-label={P.down} className="rounded p-1 hover:text-primary disabled:opacity-30" onClick={() => run(p.id, () => updatePositionAction(p.id, { move: "down" }))}><ArrowDown className="size-3.5" /></button>
            </>
          )}
          <button type="button" title={P.rename} aria-label={P.rename} className="rounded p-1 hover:text-primary" onClick={() => { const next = window.prompt(P.name, p.name)?.trim(); if (next && next !== p.name) run(p.id, () => updatePositionAction(p.id, { name: next })) }}><Pencil className="size-3.5" /></button>
          <button type="button" title={P.renameRu} aria-label={P.renameRu} className="rounded px-1 text-[10px] font-semibold hover:text-primary" onClick={() => { const next = window.prompt(P.nameRu, p.nameRu ?? ""); if (next !== null && next.trim() !== (p.nameRu ?? "")) run(p.id, () => updatePositionAction(p.id, { nameRu: next.trim() || null })) }}>RU</button>
          <button type="button" title={p.archived ? P.restore : P.archive} aria-label={p.archived ? P.restore : P.archive} className="rounded p-1 hover:text-primary" onClick={() => run(p.id, () => updatePositionAction(p.id, { archived: !p.archived }))}>{p.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}</button>
          {busy === p.id && <Loader2 className="size-3.5 animate-spin" />}
        </span>
      )}
    </li>
  )

  return (
    <Panel title={P.title} onClose={props.onClose}>
      <p className="text-xs text-muted-foreground">{P.hint}</p>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <ul className="max-h-[50vh] overflow-auto">
        {active.map((p, i) => row(p, i, active))}
        {showArchived && archived.map((p, i) => row(p, i, archived))}
      </ul>
      {archived.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-[var(--primary)]" /> {P.archived} ({archived.length})</label>
      )}
      {props.canManage && (
        <form className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-3" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await run("add", () => createPositionAction(name, nameRu || null)))) { setName(""); setNameRu("") } }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={P.name} maxLength={80} className="h-8 w-44" aria-label={P.name} />
          <Input value={nameRu} onChange={(e) => setNameRu(e.target.value)} placeholder={P.nameRu} maxLength={80} className="h-8 w-52" aria-label={P.nameRu} />
          <Button size="sm" type="submit" disabled={!name.trim() || busy === "add"}><Plus /> {P.add}</Button>
        </form>
      )}
    </Panel>
  )
}
