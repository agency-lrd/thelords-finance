"use client"

import Decimal from "decimal.js"
import { Download, Eye, History, Archive, Plus, Wallet, Check, AlertTriangle, Search, Building2, Filter, Loader2, Undo2, UserPlus, SlidersHorizontal, Copy } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import { fill, type Dictionary } from "@/lib/i18n/dictionaries"
import { formatAmount, formatDate, monthName, normalizeNumber, type Locale } from "@/lib/i18n/format"
import { dictionaries } from "@/lib/i18n/dictionaries"
import type { RuleConfig, RuleModel, SheetRow } from "@/lib/data/sheet"
import { sheetAdminTexts } from "@/lib/i18n/sheet-admin"

import { NO_DEPT, paletteFor, PALETTE } from "./palette"
import { MonthPicker, StatusBadges } from "./month-header"
import { ApprovalDialog, CarryForwardDialog, ConditionsDialog } from "./payroll-dialogs"
import { ArchivePanel, BulkFixDialog, DepartmentManager, type SheetDepartment } from "./sheet-admin"
import { withMonth } from "@/lib/month-nav"
import {
  addEmployeeAction,
  archiveEmployeeAction,
  confirmRowAction,
  historyAction,
  recordPaymentAction,
  revealWalletAction,
  setTermsAction,
  updateCellAction,
} from "./actions"

type Perms = {
  employee: boolean
  salary: boolean
  kpi: boolean
  adjustment: boolean
  compensation: boolean
  wallet: boolean
  prepare: boolean
  approve: boolean
  pay: boolean
  history: boolean
  structure: boolean
  deleteEmployee: boolean
  periodClose: boolean
  periodReopen: boolean
}

type Props = {
  locale: Locale
  monthKey: string
  baseCurrency: string
  runStatus: string | null
  editable: boolean
  rows: SheetRow[]
  departments: SheetDepartment[]
  accounts: { id: string; name: string; currency: string }[]
  perms: Perms
  period: { status: "OPEN" | "CLOSING" | "CLOSED" | "LOCKED"; closedAt: string | null; closedBy: string | null; draftEntries: number }
}

type Undo = { employeeId: string; col: ColKey; before: string; after: string }

type ColKey =
  | "name"
  | "department"
  | "fix"
  | "terms"
  | "variable"
  | "bonus"
  | "deduction"
  | "kpiTarget"
  | "kpiActual"
  | "commission"
  | "fact"
  | "calculated"
  | "confirm"
  | "approved"
  | "paid"
  | "outstanding"
  | "wallet"
  | "startWork"
  | "position"
  | "status"
  | "teamLead"
  | "currency"
  | "paymentStatus"
  | "paymentDate"
  | "notes"

type Kind = "text" | "money" | "select" | "check" | "terms" | "wallet" | "date" | "output"
type Col = { key: ColKey; kind: Kind; width: number; field?: string; can: boolean; money?: boolean }

const MONEY_TOTALS: ColKey[] = ["fix", "variable", "bonus", "deduction", "kpiTarget", "kpiActual", "calculated", "fact", "approved", "paid", "outstanding"]


const STATUSES = ["ONBOARDING", "ACTIVE", "ON_LEAVE", "TERMINATED"] as const
const CURRENCIES = ["USD", "USDT", "EUR", "GBP"] as const


type Toast = { id: number; text: string; tone: "ok" | "error" }

/** Text of a cell as the sheet shows it and copy puts on the clipboard. */
function baseValue(row: SheetRow, col: ColKey, t: Dictionary): string {
  switch (col) {
    case "name": return row.name
    case "department": return row.departmentName ?? ""
    case "fix": return row.fix ?? ""
    case "terms": return row.terms ?? ""
    case "variable": return row.variable
    case "bonus": return row.bonus === "0" ? "" : row.bonus
    case "deduction": return row.deduction === "0" ? "" : row.deduction
    case "kpiTarget": return row.kpiTarget ?? ""
    case "kpiActual": return row.kpiActual ?? ""
    case "commission": return row.commissionPct ?? ""
    case "fact": return row.payable
    case "calculated": return row.calculated
    case "confirm": return row.confirmed ? "TRUE" : "FALSE"
    case "approved": return row.approved ?? ""
    case "paid": return row.paid
    case "outstanding": return row.outstanding ?? ""
    case "wallet": return row.wallet?.masked ?? ""
    case "startWork": return row.hireDate
    case "position": return row.position ?? ""
    case "status": return t.sheet.employeeStatus[row.status as keyof Dictionary["sheet"]["employeeStatus"]] ?? row.status
    case "teamLead": return row.isTeamLead ? "TRUE" : "FALSE"
    case "currency": return row.currency
    case "paymentStatus": return t.sheet.paymentStatus[row.paymentStatus as keyof Dictionary["sheet"]["paymentStatus"]]
    case "paymentDate": return row.paymentDate ?? ""
    case "notes": return row.notes ?? ""
  }
}


export function FinancialSheet(props: Props) {
  const { locale, monthKey, baseCurrency, rows, perms, editable } = props
  const t = dictionaries[locale] as Dictionary
  const A = sheetAdminTexts[locale]
  // Active departments drive the dropdowns and colors; archived ones are only in the department manager.
  const departments = useMemo(() => props.departments.filter((d) => !d.archived), [props.departments])
  const [panel, setPanel] = useState<null | "departments" | "addDepartment" | "archive" | "bulkFix" | "approve" | "carry">(null)
  const [conditionsFor, setConditionsFor] = useState<SheetRow | null>(null)
  // Confirmation checkboxes change at once; the server result then confirms or rolls them back.
  const [confirmOverride, setConfirmOverride] = useState<Record<string, boolean>>({})
  const [confirmSaving, setConfirmSaving] = useState<Record<string, boolean>>({})
  const [showFilters, setShowFilters] = useState(true)
  const [inflight, setInflight] = useState(0)
  const [bulkDept, setBulkDept] = useState("")
  const undoStack = useRef<Undo[]>([])
  const router = useRouter()
  const [refreshing, startRefresh] = useTransition()
  const [deptFilter, setDeptFilter] = useState("")
  const [query, setQuery] = useState("")
  const [extra, setExtra] = useState(false)
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null)
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null)
  const [pending, setPending] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [termsFor, setTermsFor] = useState<SheetRow | null>(null)
  const [payFor, setPayFor] = useState<SheetRow | null>(null)
  const [historyFor, setHistoryFor] = useState<SheetRow | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [y, m] = monthKey.split("-").map(Number)
  const monthTitle = monthName(y, m, locale)
  const paying = props.runStatus === "APPROVED" || props.runStatus === "PAYING"

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random()
    setToasts((list) => [...list.slice(-3), { id, text, tone }])
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), tone === "error" ? 6000 : 2500)
  }, [])

  const refresh = useCallback(() => startRefresh(() => router.refresh()), [router])

  // Month changes keep the URL in sync (bookmarkable) and never drop a cell that is being edited or saved.
  const unsaved = editing !== null || inflight > 0
  function navigate(key: string) {
    if (unsaved && !window.confirm(A.month.unsaved)) return
    router.push(withMonth(window.location.search, key))
  }
  useEffect(() => {
    if (!unsaved) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [unsaved])

  // Pending optimistic values are dropped once fresh rows arrive from the server.
  const [rowsSeen, setRowsSeen] = useState(rows)
  if (rowsSeen !== rows) {
    setRowsSeen(rows)
    setConfirmOverride({})
    setPending({})
  }

  const deptIndex = useMemo(() => new Map(departments.map((d, i) => [d.id, { i, color: d.color }])), [departments])
  const color = (id: string | null) => (id && deptIndex.has(id) ? paletteFor(deptIndex.get(id)!.color, deptIndex.get(id)!.i) : NO_DEPT)

  const cols: Col[] = useMemo(() => {
    const canEdit = (p: boolean) => editable && p
    const base: Col[] = [
      { key: "name", kind: "text", width: 190, field: "name", can: canEdit(perms.employee) },
      { key: "department", kind: "select", width: 170, field: "department", can: canEdit(perms.employee) },
      { key: "fix", kind: "money", width: 120, field: "fix", can: canEdit(perms.salary), money: true },
      { key: "terms", kind: "terms", width: 200, can: canEdit(perms.compensation) },
      { key: "kpiTarget", kind: "money", width: 120, field: "kpiTarget", can: canEdit(perms.kpi), money: true },
      { key: "kpiActual", kind: "money", width: 120, field: "kpiActual", can: canEdit(perms.kpi), money: true },
      { key: "commission", kind: "money", width: 100, field: "commission", can: canEdit(perms.compensation) },
      { key: "variable", kind: "output", width: 110, can: false, money: true },
      { key: "bonus", kind: "money", width: 115, field: "bonus", can: canEdit(perms.adjustment), money: true },
      { key: "calculated", kind: "output", width: 130, can: false, money: true },
      { key: "fact", kind: "money", width: 150, field: "fact", can: canEdit(perms.salary), money: true },
      { key: "confirm", kind: "check", width: 84, can: canEdit(perms.prepare) },
      { key: "wallet", kind: "wallet", width: 190, field: "wallet", can: canEdit(perms.wallet) },
      { key: "startWork", kind: "date", width: 100, field: "hireDate", can: canEdit(perms.employee) },
    ]
    // After approval the payment columns matter; otherwise they are in "more columns".
    if (paying) base.push({ key: "outstanding", kind: "output", width: 130, can: false, money: true })
    if (!extra) return base
    return [
      ...base,
      { key: "deduction", kind: "money", width: 105, field: "deduction", can: canEdit(perms.adjustment), money: true },
      { key: "approved", kind: "output", width: 125, can: false, money: true },
      { key: "paid", kind: "output", width: 110, can: false, money: true },
      ...(paying ? [] : [{ key: "outstanding" as const, kind: "output" as const, width: 130, can: false, money: true }]),
      { key: "position", kind: "text", width: 150, field: "position", can: canEdit(perms.employee) },
      { key: "status", kind: "select", width: 120, field: "status", can: canEdit(perms.employee) },
      { key: "teamLead", kind: "check", width: 60, field: "isTeamLead", can: canEdit(perms.employee) },
      { key: "currency", kind: "select", width: 90, field: "currency", can: canEdit(perms.salary) },
      { key: "paymentStatus", kind: "output", width: 130, can: false },
      { key: "paymentDate", kind: "output", width: 110, can: false },
      { key: "notes", kind: "text", width: 220, field: "notes", can: canEdit(perms.employee) },
    ]
  }, [editable, perms, extra, paying])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!deptFilter || (deptFilter === "none" ? !r.departmentId : r.departmentId === deptFilter)) &&
        (!q || [r.name, r.position, r.notes, r.wallet?.masked, r.departmentName].some((v) => v?.toLowerCase().includes(q))),
    )
  }, [rows, deptFilter, query])

  const key = (row: SheetRow, col: ColKey) => `${row.employeeId}:${col}`

  /** Raw value of a cell: what editing starts with and what copy puts on the clipboard. */
  const raw = useCallback(
    (row: SheetRow, col: ColKey): string => {
      const p = pending[key(row, col)]
      if (p !== undefined) return p
      return baseValue(row, col, t)
    },
    [pending, t],
  )

  // ── Saving ──

  /** What the server last sent for a cell, in the form the server compares (department id, status code…). */
  function serverValue(row: SheetRow, col: ColKey) {
    switch (col) {
      case "department": return row.departmentId ?? ""
      case "status": return row.status
      case "teamLead": return String(row.isTeamLead)
      case "bonus": return row.bonus
      case "deduction": return row.deduction
      case "fact": return row.fact ?? ""
      default: return baseValue(row, col, t)
    }
  }

  async function saveCell(row: SheetRow, col: Col, input: string, { quiet = false, expected, undoable = true }: { quiet?: boolean; expected?: string; undoable?: boolean } = {}) {
    if (!col.can || !col.field) return false
    let value = input.trim()
    if (col.kind === "money") {
      const n = normalizeNumber(value)
      if (n === null) {
        toast(`${t.sheet.col[col.key as keyof Dictionary["sheet"]["col"]]}: "${input}" — ${locale === "ru" ? "не число" : "not a number"}`, "error")
        return false
      }
      value = n
    }
    if (col.key === "department") {
      const match = departments.find((d) => d.id === value || d.name.toLowerCase() === value.toLowerCase())
      if (!match) {
        toast(`${t.sheet.col.department}: "${input}"?`, "error")
        return false
      }
      value = match.id
    }
    if (col.key === "status") {
      const match = STATUSES.find((s) => s === value || t.sheet.employeeStatus[s].toLowerCase() === value.toLowerCase())
      if (!match) return false
      value = match
    }
    if (col.key === "currency") {
      value = value.toUpperCase()
      if (!(CURRENCIES as readonly string[]).includes(value)) {
        toast(`${t.sheet.col.currency}: "${input}"? (${CURRENCIES.join(", ")})`, "error")
        return false
      }
    }
    if (col.key === "teamLead") value = /^(true|1|yes|да|x|✓)$/i.test(value) ? "true" : "false"
    if (col.key === "startWork") {
      const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(value)
      if (ru) value = `${ru[3].length === 2 ? `20${ru[3]}` : ru[3]}-${ru[2].padStart(2, "0")}-${ru[1].padStart(2, "0")}`
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        toast(`${t.sheet.col.startWork}: "${input}"?`, "error")
        return false
      }
    }
    // FACT PAYMENT below the calculated salary is a correction: ask for the reason once.
    let reason: string | null = null
    if (col.key === "fact" && value !== "" && Number(value) < Number(row.calculated) && !row.factReason) {
      reason = window.prompt(A.payroll.factReasonPrompt)?.trim() || null
      if (!reason) return false
    }
    const before = expected ?? serverValue(row, col.key)
    setPending((p) => ({ ...p, [key(row, col.key)]: col.kind === "money" || col.key === "startWork" ? (col.key === "fact" && value === "" ? row.calculated : value) : input }))
    setInflight((n) => n + 1)
    const result = await updateCellAction(monthKey, row.employeeId, col.field, value, col.key === "wallet" ? null : before, reason).catch(() => ({ ok: false as const, message: locale === "ru" ? "Соединение прервано" : "Connection lost" }))
    setInflight((n) => n - 1)
    if (!result.ok) {
      setPending((p) => {
        const next = { ...p }
        delete next[key(row, col.key)]
        return next
      })
      if ("conflict" in result && result.conflict) {
        toast(fill(A.conflict, { current: result.conflict.current || "—" }), "error")
        refresh()
      } else toast(result.message, "error")
      return false
    }
    if (undoable && col.key !== "wallet") undoStack.current = [...undoStack.current.slice(-49), { employeeId: row.employeeId, col: col.key, before, after: value }]
    if (!quiet) toast(result.unconfirmed ? `${t.sheet.rowsSaved} · ${t.sheet.changedAfterConfirm}` : t.sheet.rowsSaved)
    return true
  }

  /** Reverts the last saved cell (only if nobody changed it since). */
  async function undo() {
    const last = undoStack.current.pop()
    if (!last) return toast(A.nothingToUndo)
    const row = rows.find((r) => r.employeeId === last.employeeId)
    const col = cols.find((c) => c.key === last.col)
    if (!row || !col) return
    const before = (last.col === "bonus" || last.col === "deduction") && last.before === "0" ? "" : last.before
    if (await saveCell(row, col, before, { quiet: true, expected: last.after, undoable: false })) {
      toast(A.undone)
      // The server action revalidates /payroll and returns the fresh sheet in the same round trip: no extra refresh.
    }
  }


  async function toggle(row: SheetRow, col: Col) {
    if (!col.can) return
    if (col.key === "confirm") {
      const id = row.employeeId
      if (confirmSaving[id]) return
      const shown = confirmOverride[id] ?? (row.confirmed && !row.stale)
      const target = !shown
      setConfirmOverride((c) => ({ ...c, [id]: target }))
      setConfirmSaving((c) => ({ ...c, [id]: true }))
      const result = await confirmRowAction(monthKey, id, target).catch(() => ({ ok: false as const, message: locale === "ru" ? "Соединение прервано — изменение не сохранено" : "Connection lost: not saved" }))
      setConfirmSaving((c) => {
        const next = { ...c }
        delete next[id]
        return next
      })
      if (!result.ok) {
        setConfirmOverride((c) => {
          const next = { ...c }
          delete next[id]
          return next
        })
        toast(result.message, "error")
        return
      }
      toast(fill(target ? A.payroll.confirmed : A.payroll.unconfirmed, { name: row.name }))
      // The server action revalidates /payroll and returns the fresh sheet in the same round trip: no extra refresh.
      return
    }
    if (col.key === "teamLead") {
      await saveCell(row, col, row.isTeamLead ? "false" : "true")
      // The server action revalidates /payroll and returns the fresh sheet in the same round trip: no extra refresh.
    }
  }

  // ── Keyboard, selection, clipboard ──

  const clamp = (r: number, c: number) => ({ r: Math.max(0, Math.min(visible.length - 1, r)), c: Math.max(0, Math.min(cols.length - 1, c)) })

  function move(dr: number, dc: number, extend = false) {
    const next = clamp(active.r + dr, active.c + dc)
    if (extend) setAnchor((a) => a ?? active)
    else setAnchor(null)
    setActive(next)
  }

  function beginEdit(initial?: string) {
    const row = visible[active.r]
    const col = cols[active.c]
    if (!row || !col) return
    if (col.kind === "terms") {
      if (col.can) setTermsFor(row)
      return
    }
    if (col.kind === "check") return void toggle(row, col)
    if (!col.can) return
    const start = initial ?? (col.kind === "wallet" ? "" : col.key === "department" ? (row.departmentId ?? "") : col.key === "status" ? row.status : raw(row, col.key))
    setEditing({ ...active, value: start })
  }

  async function commitEdit(then?: () => void) {
    if (!editing) return
    const row = visible[editing.r]
    const col = cols[editing.c]
    const value = editing.value
    setEditing(null)
    gridRef.current?.focus()
    then?.()
    const original = col.key === "department" ? (row.departmentId ?? "") : col.key === "status" ? row.status : raw(row, col.key)
    if (value === original) return
    // Saved cells arrive fresh with the action response (revalidatePath); no second full reload.
    await saveCell(row, col, value)
  }

  const selection = useMemo(() => {
    const a = anchor ?? active
    return { r1: Math.min(a.r, active.r), r2: Math.max(a.r, active.r), c1: Math.min(a.c, active.c), c2: Math.max(a.c, active.c) }
  }, [anchor, active])

  async function copySelection() {
    const lines: string[] = []
    for (let r = selection.r1; r <= selection.r2; r++) {
      const cells: string[] = []
      for (let c = selection.c1; c <= selection.c2; c++) cells.push(raw(visible[r], cols[c].key).replace(/[\t\n]/g, " "))
      lines.push(cells.join("\t"))
    }
    await navigator.clipboard.writeText(lines.join("\n"))
    toast(t.sheet.copied)
  }

  async function paste(text: string) {
    const grid = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((line) => line.split("\t"))
    if (!editable) return toast(t.sheet.locked, "error")
    setBusy(true)
    let count = 0
    // A single copied value fills the whole selection, like spreadsheets do.
    const single = grid.length === 1 && grid[0].length === 1
    const height = single ? selection.r2 - selection.r1 + 1 : grid.length
    const width = single ? selection.c2 - selection.c1 + 1 : grid[0].length
    for (let dr = 0; dr < height; dr++) {
      for (let dc = 0; dc < width; dc++) {
        const row = visible[selection.r1 + dr]
        const col = cols[selection.c1 + dc]
        const value = single ? grid[0][0] : grid[dr]?.[dc]
        if (!row || !col || value === undefined || !col.can || !col.field || col.kind === "wallet" && !value.trim()) continue
        if (col.kind === "check") {
          if (col.key === "teamLead" && (await saveCell(row, col, value, { quiet: true }))) count++
          continue
        }
        if (await saveCell(row, col, value, { quiet: true })) count++
      }
    }
    setBusy(false)
    toast(fill(t.sheet.pasteDone, { n: count }))
    refresh()
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (editing || termsFor || payFor || historyFor || panel || conditionsFor) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault()
      void copySelection()
      return
    }
    if (mod && event.key.toLowerCase() === "v") return // handled by the paste event
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault()
      void undo()
      return
    }
    switch (event.key) {
      case "ArrowUp": event.preventDefault(); return move(-1, 0, event.shiftKey)
      case "ArrowDown": event.preventDefault(); return move(1, 0, event.shiftKey)
      case "ArrowLeft": event.preventDefault(); return move(0, -1, event.shiftKey)
      case "ArrowRight": event.preventDefault(); return move(0, 1, event.shiftKey)
      case "Tab": event.preventDefault(); return move(0, event.shiftKey ? -1 : 1)
      case "Enter":
      case "F2": event.preventDefault(); return beginEdit()
      case " ": event.preventDefault(); return beginEdit()
      case "Escape": return setAnchor(null)
      case "Delete":
      case "Backspace": {
        event.preventDefault()
        const targets: [SheetRow, Col][] = []
        for (let r = selection.r1; r <= selection.r2; r++) for (let c = selection.c1; c <= selection.c2; c++) {
          const col = cols[c]
          if (col.can && col.field && ["bonus", "deduction", "kpiTarget", "kpiActual", "notes", "position", "wallet"].includes(col.key)) targets.push([visible[r], col])
        }
        void (async () => {
          for (const [row, col] of targets) await saveCell(row, col, "", { quiet: true })
          if (targets.length) refresh()
        })()
        return
      }
    }
    if (event.key.length === 1 && !mod && !event.altKey) {
      const col = cols[active.c]
      if (col && (col.kind === "money" || col.kind === "text" || col.kind === "wallet" || col.kind === "date")) {
        event.preventDefault()
        beginEdit(event.key)
      }
    }
  }

  useEffect(() => {
    const node = gridRef.current
    if (!node) return
    const handler = (event: ClipboardEvent) => {
      if (editing || termsFor || payFor) return
      const text = event.clipboardData?.getData("text/plain")
      if (!text) return
      event.preventDefault()
      void paste(text)
    }
    node.addEventListener("paste", handler)
    return () => node.removeEventListener("paste", handler)
  })

  // Keep the active cell visible.
  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${active.r}:${active.c}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])

  // ── Totals ──

  const totalsFor = useCallback(
    (list: SheetRow[]) => {
      const sums = Object.fromEntries(MONEY_TOTALS.map((k) => [k, new Decimal(0)])) as Record<ColKey, Decimal>
      let excluded = 0
      for (const row of list) {
        if (row.currency !== baseCurrency) {
          excluded++
          continue
        }
        for (const k of MONEY_TOTALS) {
          const v = raw(row, k)
          const n = v ? normalizeNumber(v) : ""
          if (n) sums[k] = sums[k].add(n)
        }
      }
      return { sums, excluded }
    },
    [raw, baseCurrency],
  )

  const groups = useMemo(() => {
    const out: { id: string | null; name: string; rows: { row: SheetRow; index: number }[] }[] = []
    visible.forEach((row, index) => {
      const last = out[out.length - 1]
      if (last && last.id === row.departmentId) last.rows.push({ row, index })
      else out.push({ id: row.departmentId, name: row.departmentName ?? t.sheet.noDepartment, rows: [{ row, index }] })
    })
    return out
  }, [visible, t])

  const grand = totalsFor(visible)
  const unconfirmed = rows.filter((r) => !r.confirmed || r.stale).length

  // ── Bulk actions on the selected rows ──

  const selectedRows = anchor && selection.r2 > selection.r1 ? visible.slice(selection.r1, selection.r2 + 1) : []
  const colOf = (k: ColKey) => cols.find((c) => c.key === k)

  async function bulk(list: SheetRow[], action: (row: SheetRow) => Promise<boolean>) {
    setBusy(true)
    let ok = 0
    for (const row of list) if (await action(row)) ok++
    setBusy(false)
    toast(fill(A.bulkDone, { ok, n: list.length }), ok === list.length ? "ok" : "error")
    refresh()
  }

  async function bulkDepartment() {
    const dept = departments.find((d) => d.id === bulkDept)
    const col = colOf("department")
    if (!dept || !col?.can) return
    if (!window.confirm(fill(A.bulkDepartmentConfirm, { n: selectedRows.length, dept: dept.name, month: monthTitle }))) return
    await bulk(selectedRows, (row) => (row.departmentId === dept.id ? Promise.resolve(true) : saveCell(row, col, dept.id, { quiet: true })))
  }

  async function bulkArchive() {
    if (!window.confirm(fill(A.bulkArchiveConfirm, { n: selectedRows.length }))) return
    await bulk(selectedRows, async (row) => {
      const r = await archiveEmployeeAction(row.employeeId, true)
      if (!r.ok) toast(`${row.name}: ${r.message}`, "error")
      return r.ok
    })
    setAnchor(null)
  }

  // ── Export ──

  function exportCsv() {
    const header = cols.map((c) => t.sheet.col[c.key as keyof Dictionary["sheet"]["col"]])
    const lines = [header, ...visible.map((row) => cols.map((c) => (c.key === "department" ? (row.departmentName ?? "") : raw(row, c.key))))]
    const csv = lines.map((line) => line.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n")
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }))
    const a = Object.assign(document.createElement("a"), { href: url, download: `financial-sheet-${monthKey}.csv` })
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Render ──


  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">{t.sheet.title}</p>
          <div className="flex flex-wrap items-center gap-3">
            <MonthPicker monthKey={monthKey} locale={locale} t={A} onNavigate={navigate} />
            <StatusBadges
              monthKey={monthKey}
              monthTitle={monthTitle}
              period={props.period}
              run={props.runStatus === "PAID" ? "paid" : props.runStatus === "PAYING" ? "paying" : props.runStatus === "APPROVED" ? "approved" : !editable ? "readOnly" : "draft"}
              can={{ close: perms.periodClose, reopen: perms.periodReopen }}
              t={A}
              onChanged={(message, tone) => {
                toast(message, tone)
                refresh()
              }}
            />
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{t.sheet.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-8 min-w-20 items-center gap-1.5 text-[11px] text-muted-foreground" aria-live="polite">
            {inflight > 0 ? <><Loader2 className="size-3.5 animate-spin text-primary" /> {A.saving}</> : null}
          </span>
          {editable && perms.employee && perms.salary && (
            <Button variant="outline" size="sm" onClick={() => document.getElementById("sheet-new-employee")?.focus()}>
              <UserPlus /> {A.toolbar.employee}
            </Button>
          )}
          {editable && perms.employee && perms.salary && (
            <Button variant="outline" size="sm" onClick={() => setPanel("carry")} title={A.payroll.carry}>
              <Copy /> {A.payroll.carry}
            </Button>
          )}
          {perms.structure && (
            <Button variant="outline" size="sm" onClick={() => setPanel("addDepartment")}>
              <Plus /> {A.toolbar.department}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setPanel("departments")}>
            <Building2 /> {A.toolbar.departments}
          </Button>
          {perms.employee && (
            <Button variant="outline" size="sm" onClick={() => setPanel("archive")}>
              <Archive /> {A.toolbar.archive}
            </Button>
          )}
          <Button variant={showFilters ? "secondary" : "outline"} size="sm" aria-pressed={showFilters} onClick={() => setShowFilters((v) => !v)}>
            <Filter /> {A.toolbar.filters}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void undo()} title="Ctrl/Cmd+Z">
            <Undo2 /> {A.toolbar.undo}
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download /> {t.common.export}
          </Button>
          {perms.approve && rows.length > 0 && (props.runStatus === null || props.runStatus === "DRAFT" || props.runStatus === "CALCULATED") && (
            <Button size="sm" onClick={() => setPanel("approve")} disabled={busy} title={unconfirmed ? fill(t.dashboard.unconfirmed, { n: unconfirmed }) : undefined}>
              <Check /> {t.sheet.approveMonth}
            </Button>
          )}
          {perms.approve && perms.periodReopen && props.runStatus === "APPROVED" && (
            <Button size="sm" variant="outline" onClick={() => setPanel("approve")} disabled={busy}>
              <AlertTriangle /> {A.payroll.reopen}
            </Button>
          )}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
          <span>{A.payroll.empty}</span>
          {editable && perms.employee && perms.salary && (
            <Button size="sm" onClick={() => setPanel("carry")}>
              <Copy /> {A.payroll.carry}
            </Button>
          )}
        </div>
      )}

      {/* Bulk actions for a multi-row selection (Shift+click or Shift+arrows) */}
      {selectedRows.length > 1 && editable && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
          <span className="font-semibold text-primary">{fill(A.selected, { n: selectedRows.length })}</span>
          {perms.employee && (
            <>
              <Select value={bulkDept} onChange={(e) => setBulkDept(e.target.value)} className="h-7 w-48 text-xs" aria-label={A.bulkDepartment}>
                <option value="">{A.bulkDepartment}…</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
              <Button size="sm" variant="outline" disabled={!bulkDept || busy} onClick={bulkDepartment}>{A.apply}</Button>
            </>
          )}
          {perms.salary && <Button size="sm" variant="outline" disabled={busy} onClick={() => setPanel("bulkFix")}>{A.bulkFix}</Button>}
          {perms.employee && <Button size="sm" variant="outline" disabled={busy} onClick={bulkArchive}><Archive /> {A.bulkArchive}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setAnchor(null)}>{A.cancel}</Button>
        </div>
      )}

      {/* Filters */}
      <div className={cn("flex flex-wrap items-center gap-2", !showFilters && "hidden")}>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.sheet.searchPlaceholder} className="h-9 w-64 pl-9" aria-label={t.common.search} />
        </div>
        <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="h-9 w-56" aria-label={t.sheet.filterDepartment}>
          <option value="">{t.sheet.filterDepartment}: {t.common.all}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
          <option value="none">{t.sheet.noDepartment}</option>
        </Select>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
          <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} className="accent-[var(--primary)]" />
          {t.sheet.moreColumns}
        </label>
        <span className="ml-auto hidden text-[11px] text-muted-foreground/70 xl:block">{t.sheet.help}</span>
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="grid"
        aria-label={t.sheet.title}
        aria-busy={busy || refreshing}
        className={cn(
          "relative max-h-[calc(100dvh-300px)] min-h-[320px] overflow-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10 outline-none focus-visible:ring-primary/40",
          (busy || refreshing) && "cursor-progress",
        )}
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              {cols.map((col, c) => (
                <th
                  key={col.key}
                  style={{ width: col.width, minWidth: col.width }}
                  className={cn(
                    "sticky top-0 z-20 h-10 border-b border-border bg-[#141015] px-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap text-muted-foreground",
                    col.money && "text-right",
                    c === 0 && "left-0 z-30",
                  )}
                >
                  {t.sheet.col[col.key as keyof Dictionary["sheet"]["col"]]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-6 py-16 text-center">
                  <p className="font-medium">{t.sheet.emptyTitle}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t.sheet.emptyDescription}</p>
                </td>
              </tr>
            )}
            {groups.map((group) => {
              const palette = color(group.id)
              const sub = totalsFor(group.rows.map((g) => g.row))
              return [
                ...group.rows.map(({ row, index: r }) => (
                  <tr key={row.employeeId} className="group">
                    {cols.map((col, c) => {
                      const isActive = active.r === r && active.c === c
                      const inSel = r >= selection.r1 && r <= selection.r2 && c >= selection.c1 && c <= selection.c2
                      const isEditing = editing?.r === r && editing?.c === c
                      return (
                        <td
                          key={col.key}
                          data-cell={`${r}:${c}`}
                          role="gridcell"
                          aria-selected={isActive}
                          onMouseDown={(event) => {
                            if (isEditing) return
                            if (event.shiftKey) setAnchor((a) => a ?? active)
                            else setAnchor(null)
                            setActive({ r, c })
                          }}
                          onDoubleClick={() => col.kind !== "check" && beginEdit()}
                          className={cn(
                            "relative h-9 border-b border-r border-border/50 px-3 whitespace-nowrap",
                            col.money && "text-right font-mono tabular-nums",
                            c === 0 && "sticky left-0 z-10 bg-[#0f0c10] font-medium",
                            !col.can && col.kind !== "output" && "text-foreground/90",
                            col.kind === "output" && "bg-white/[0.015]",
                            inSel && !isActive && "bg-primary/10",
                            isActive && "outline-2 -outline-offset-2 outline-primary",
                            pending[key(row, col.key)] !== undefined && "text-muted-foreground",
                          )}
                        >
                          {/* Department tint as an overlay so the sticky column stays opaque. */}
                          {c === 0 && <span aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10", palette.name)} />}
                          {isEditing ? (
                            <CellEditor
                              col={col}
                              value={editing.value}
                              departments={departments}
                              t={t}
                              onChange={(value) => setEditing((e) => (e ? { ...e, value } : e))}
                              onCommit={(dir) => commitEdit(() => dir && move(dir === "down" ? 1 : 0, dir === "right" ? 1 : 0))}
                              onCancel={() => {
                                setEditing(null)
                                gridRef.current?.focus()
                              }}
                            />
                          ) : (
                            <CellView
                              row={row}
                              col={col}
                              raw={raw(row, col.key)}
                              locale={locale}
                              t={t}
                              palette={palette}
                              paying={paying && perms.pay}
                              confirmState={{ value: confirmOverride[row.employeeId] ?? (row.confirmed && !row.stale), saving: !!confirmSaving[row.employeeId] }}
                              confirmTip={A.payroll.confirmTip}
                              onConditions={editable && (perms.salary || perms.kpi) ? () => setConditionsFor(row) : undefined}
                              conditionsLabel={A.payroll.conditions}
                              inheritedLabel={A.payroll.inherited}
                              factTexts={{ reset: A.payroll.factReset, manual: A.payroll.factManual, difference: A.payroll.factDifference, days: A.payroll.prorationDays, prorated: A.payroll.prorationTip }}
                              onResetFact={col.can && col.key === "fact" ? async () => { await saveCell(row, col, "") } : undefined}
                              onToggle={() => toggle(row, col)}
                              onTerms={() => col.can && setTermsFor(row)}
                              onPay={() => setPayFor(row)}
                              onReveal={async () => {
                                if (!row.wallet) return
                                const result = await revealWalletAction(row.wallet.id)
                                if (!result.ok) return toast(result.message, "error")
                                await navigator.clipboard.writeText(result.address)
                                toast(`${t.sheet.copied}: ${result.address}`)
                              }}
                              canReveal={perms.wallet}
                              onHistory={perms.history ? () => setHistoryFor(row) : undefined}
                              onArchive={
                                perms.employee
                                  ? async () => {
                                      if (!window.confirm(`${t.common.archive}: ${row.name}?`)) return
                                      const result = await archiveEmployeeAction(row.employeeId, true)
                                      if (!result.ok) toast(result.message, "error")
                                      refresh()
                                    }
                                  : undefined
                              }
                            />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )),
                groups.length > 1 && (
                  <tr key={`sub-${group.id ?? "none"}`}>
                    {cols.map((col, c) => (
                      <td
                        key={col.key}
                        className={cn(
                          "h-8 border-b border-border/60 bg-white/[0.025] px-3 text-[12px] font-semibold whitespace-nowrap text-muted-foreground",
                          col.money && "text-right font-mono tabular-nums",
                          c === 0 && "sticky left-0 z-10 bg-[#151116]",
                        )}
                      >
                        {c === 0 ? (
                          <span className="flex items-center gap-2">
                            <span className={cn("size-2 rounded-full", palette.bar)} />
                            {t.sheet.subtotal} · {group.name}
                          </span>
                        ) : col.money && MONEY_TOTALS.includes(col.key) ? (
                          formatAmount(sub.sums[col.key].toString(), baseCurrency, locale, { blankZero: true })
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ),
              ]
            })}
          </tbody>
          {visible.length > 0 && (
            <tfoot>
              <tr>
                {cols.map((col, c) => (
                  <td
                    key={col.key}
                    className={cn(
                      "sticky bottom-0 z-20 h-10 border-t border-primary/40 bg-[#3a0d29] px-3 font-semibold whitespace-nowrap text-white",
                      col.money && "text-right font-mono tabular-nums",
                      c === 0 && "left-0 z-30",
                    )}
                  >
                    {c === 0 ? t.common.total : col.money && MONEY_TOTALS.includes(col.key) ? formatAmount(grand.sums[col.key].toString(), baseCurrency, locale, { blankZero: true }) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {grand.excluded > 0 && <p className="text-xs text-amber-300/80">{fill(t.sheet.mixedCurrency, { n: grand.excluded })}</p>}

      {editable && perms.employee && perms.salary && <AddEmployee monthKey={monthKey} departments={departments} t={t} hint={A.newRow} toast={toast} onDone={refresh} />}

      {termsFor && (
        <TermsDialog
          row={termsFor}
          monthTitle={monthTitle}
          t={t}
          onClose={() => setTermsFor(null)}
          onSave={async (config) => {
            const result = await setTermsAction(monthKey, termsFor.employeeId, config)
            if (!result.ok) return toast(result.message, "error")
            setTermsFor(null)
            toast(t.sheet.rowsSaved)
            refresh()
          }}
        />
      )}
      {payFor && (
        <PaymentDialog
          row={payFor}
          accounts={props.accounts}
          locale={locale}
          t={t}
          onClose={() => setPayFor(null)}
          onSave={async (input) => {
            const result = await recordPaymentAction(monthKey, { ...input, employeeId: payFor.employeeId })
            if (!result.ok) return toast(result.message, "error")
            setPayFor(null)
            toast(t.sheet.rowsSaved)
            refresh()
          }}
        />
      )}
      {historyFor && <HistoryDialog row={historyFor} locale={locale} t={t} onClose={() => setHistoryFor(null)} />}
      {(panel === "departments" || panel === "addDepartment") && (
        <DepartmentManager
          departments={props.departments}
          monthKey={monthKey}
          monthTitle={monthTitle}
          canManage={perms.structure}
          focusAdd={panel === "addDepartment"}
          t={A}
          toast={toast}
          onChanged={refresh}
          onClose={() => {
            setPanel(null)
            gridRef.current?.focus()
          }}
        />
      )}
      {panel === "archive" && (
        <ArchivePanel
          t={A}
          canManage={perms.employee}
          canDelete={perms.deleteEmployee}
          toast={toast}
          onChanged={refresh}
          onClose={() => {
            setPanel(null)
            gridRef.current?.focus()
          }}
        />
      )}
      {panel === "approve" && (
        <ApprovalDialog monthKey={monthKey} monthTitle={monthTitle} locale={locale} t={A} canConfirm={perms.prepare && editable} toast={toast} onChanged={refresh} onClose={() => setPanel(null)} />
      )}
      {panel === "carry" && (
        <CarryForwardDialog monthKey={monthKey} monthTitle={monthTitle} departments={departments} locale={locale} t={A} toast={toast} onChanged={refresh} onClose={() => setPanel(null)} />
      )}
      {conditionsFor && (
        <ConditionsDialog
          monthKey={monthKey}
          row={{ employeeId: conditionsFor.employeeId, name: conditionsFor.name, fix: conditionsFor.fix, currency: conditionsFor.currency, kpiTarget: conditionsFor.kpiTarget, kpiTargetInherited: conditionsFor.kpiTargetInherited }}
          t={A}
          toast={toast}
          onChanged={refresh}
          onClose={() => setConditionsFor(null)}
        />
      )}
      {panel === "bulkFix" && (
        <BulkFixDialog
          rows={selectedRows.map((r) => ({ employeeId: r.employeeId, name: r.name, fix: r.fix, currency: r.currency }))}
          t={A}
          locale={locale}
          monthTitle={monthTitle}
          onClose={() => setPanel(null)}
          onApply={async (changes) => {
            const col = colOf("fix")
            if (!col) return
            await bulk(
              selectedRows.filter((r) => changes.some((c) => c.employeeId === r.employeeId)),
              (row) => saveCell(row, col, changes.find((c) => c.employeeId === row.employeeId)!.fix, { quiet: true }),
            )
          }}
        />
      )}

      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={cn("pointer-events-auto max-w-sm rounded-xl px-4 py-2.5 text-sm shadow-2xl ring-1 backdrop-blur", x.tone === "error" ? "bg-destructive/15 text-red-200 ring-destructive/40" : "bg-card/90 text-foreground ring-primary/30")}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function CellView(props: {
  row: SheetRow
  col: Col
  raw: string
  locale: Locale
  t: Dictionary
  palette: (typeof PALETTE)[number]
  paying: boolean
  canReveal: boolean
  onToggle: () => void
  onTerms: () => void
  onPay: () => void
  onReveal: () => void
  onHistory?: () => void
  onArchive?: () => void
  confirmState: { value: boolean; saving: boolean }
  confirmTip: string
  onConditions?: () => void
  conditionsLabel: string
  inheritedLabel: string
  factTexts: { reset: string; manual: string; difference: string; days: string; prorated: string }
  onResetFact?: () => void
}) {
  const { row, col, raw, locale, t } = props
  const money = (v: string | null, opts = {}) => formatAmount(v, row.currency, locale, opts)
  switch (col.key) {
    case "name":
      return (
        <span className="flex items-center gap-2">
          <span className="truncate">{raw}</span>
          {row.isTeamLead && <span className="rounded bg-primary/20 px-1 text-[10px] font-bold text-primary">ТЛ</span>}
          {row.status !== "ACTIVE" && <span className="text-[10px] uppercase text-muted-foreground">{t.sheet.employeeStatus[row.status as keyof Dictionary["sheet"]["employeeStatus"]]}</span>}
          <span className="ml-auto hidden gap-1 group-hover:flex">
            {props.onConditions && (
              <button type="button" onClick={props.onConditions} className="text-muted-foreground hover:text-primary" title={props.conditionsLabel} aria-label={props.conditionsLabel}>
                <SlidersHorizontal className="size-3.5" />
              </button>
            )}
            {props.onHistory && (
              <button type="button" onClick={props.onHistory} className="text-muted-foreground hover:text-primary" title={t.sheet.history} aria-label={t.sheet.history}>
                <History className="size-3.5" />
              </button>
            )}
            {props.onArchive && (
              <button type="button" onClick={props.onArchive} className="text-muted-foreground hover:text-destructive" title={t.common.archive} aria-label={t.common.archive}>
                <Archive className="size-3.5" />
              </button>
            )}
          </span>
        </span>
      )
    case "department":
      return row.departmentName ? (
        <span className={cn("inline-flex max-w-full items-center truncate rounded-full px-2.5 py-0.5 text-[11px] font-semibold", props.palette.chip)}>{row.departmentName}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case "fix":
      return (
        <span
          className="flex items-center justify-end gap-1.5 font-semibold"
          title={row.proration && row.fixProrated ? fill(props.factTexts.prorated, { fix: money(raw || null), days: String(row.proration.days), divisor: String(row.proration.divisor), amount: money(row.fixProrated) }) : undefined}
        >
          {!row.salaryApproved && <span title={t.sheet.salaryPending}><AlertTriangle className="size-3 text-amber-400" /></span>}
          {row.proration && <span className="rounded bg-sky-500/15 px-1 font-sans text-[10px] font-medium text-sky-300">{fill(props.factTexts.days, { days: String(row.proration.days), divisor: String(row.proration.divisor) })}</span>}
          {money(raw || null)}
        </span>
      )
    case "commission":
      return <>{raw ? `${raw}%` : <span className="text-muted-foreground">—</span>}</>
    case "fact": {
      const manual = row.fact !== null
      const diff = Number(row.payable) - Number(row.calculated)
      return (
        <span className="flex items-center justify-end gap-1.5 font-semibold" title={manual ? `${props.factTexts.manual}${row.factReason ? `: ${row.factReason}` : ""}\n${props.factTexts.difference}: ${money(String(diff))}` : undefined}>
          {manual && props.onResetFact && (
            <button type="button" onClick={(e) => { e.stopPropagation(); props.onResetFact?.() }} className="font-sans text-[11px] text-muted-foreground hover:text-primary" title={props.factTexts.reset} aria-label={props.factTexts.reset}>↺</button>
          )}
          {manual && diff !== 0 && <span className={cn("font-sans text-[10px]", diff > 0 ? "text-emerald-300" : "text-amber-300")}>{diff > 0 ? "+" : ""}{formatAmount(String(diff), row.currency, locale)}</span>}
          <span className={cn(manual && "text-amber-200 underline decoration-dotted")}>{money(raw)}</span>
        </span>
      )
    }
    case "terms":
      return (
        <button type="button" onClick={props.onTerms} className={cn("block w-full truncate text-left font-medium", !props.col.can && "cursor-default")}>
          {raw || <span className="text-muted-foreground">{t.sheet.terms.models.NONE}</span>}
        </button>
      )
    case "bonus":
    case "deduction":
      return (
        <span className="flex items-center justify-end gap-1.5">
          {row.pendingAdjustments > 0 && <span className="text-[10px] text-amber-300" title={t.sheet.pendingApproval}>●</span>}
          {money(raw || "0", { blankZero: true })}
        </span>
      )
    case "kpiTarget":
      return (
        <span className="flex items-center justify-end gap-1" title={row.kpiTargetInherited ? props.inheritedLabel : undefined}>
          {row.kpiTargetInherited && <span className="text-[10px] text-primary/80">↻</span>}
          {money(raw || null)}
        </span>
      )
    case "variable":
    case "kpiActual":
      return <>{money(raw || null, { blankZero: col.key === "variable" })}</>
    case "calculated":
      return (
        <span className="flex items-center justify-end gap-1.5 font-semibold">
          {row.warnings.length > 0 && <span title={row.warnings.join("\n")}><AlertTriangle className="size-3 text-amber-400" /></span>}
          {money(raw)}
        </span>
      )
    case "confirm":
      return (
        <span className="flex justify-center">
          <button
            type="button"
            onClick={props.onToggle}
            disabled={!col.can || props.confirmState.saving}
            aria-pressed={props.confirmState.value}
            aria-busy={props.confirmState.saving}
            title={row.stale && !props.confirmState.saving ? t.sheet.changedAfterConfirm : props.confirmTip}
            className={cn(
              "flex size-5 items-center justify-center rounded border transition-colors",
              props.confirmState.value ? "border-primary bg-primary text-primary-foreground" : row.stale ? "border-amber-400 text-amber-400" : "border-muted-foreground/50 hover:border-primary",
              !col.can && "opacity-60",
              props.confirmState.saving && "opacity-70",
            )}
          >
            {props.confirmState.saving ? <Loader2 className="size-3 animate-spin" /> : props.confirmState.value ? <Check className="size-3.5" /> : row.stale ? <AlertTriangle className="size-3" /> : null}
          </button>
        </span>
      )
    case "approved":
      return <span className={cn("font-semibold", row.approved && "text-white")}>{row.approved ? money(row.approved) : "—"}</span>
    case "paid":
      return <>{money(raw, { blankZero: true })}</>
    case "outstanding":
      return (
        <span className="flex items-center justify-end gap-2">
          {props.paying && row.outstanding && row.outstanding !== "0" && (
            <button type="button" onClick={props.onPay} className="rounded-full border border-primary/50 px-2 text-[11px] font-sans text-primary hover:bg-primary/15">
              {t.sheet.pay}
            </button>
          )}
          {row.outstanding ? money(row.outstanding, { blankZero: true }) : "—"}
        </span>
      )
    case "wallet":
      return row.wallet ? (
        <span className="flex items-center gap-2 font-mono text-[12px]">
          <Wallet className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{row.wallet.masked}</span>
          {row.wallet.network && <span className="text-[10px] text-muted-foreground">{row.wallet.network}</span>}
          {props.canReveal && (
            <button type="button" onClick={props.onReveal} className="ml-auto text-muted-foreground hover:text-primary" title={t.sheet.reveal} aria-label={t.sheet.reveal}>
              <Eye className="size-3.5" />
            </button>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )
    case "startWork":
      return <>{formatDate(raw, locale)}</>
    case "teamLead":
      return (
        <span className="flex justify-center">
          <button type="button" onClick={props.onToggle} disabled={!col.can} className={cn("flex size-5 items-center justify-center rounded border", row.isTeamLead ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50")}>
            {row.isTeamLead && <Check className="size-3.5" />}
          </button>
        </span>
      )
    case "paymentDate":
      return <>{formatDate(raw || null, locale)}</>
    default:
      return <span className="block truncate">{raw || <span className="text-muted-foreground">—</span>}</span>
  }
}

function CellEditor(props: {
  col: Col
  value: string
  departments: { id: string; name: string }[]
  t: Dictionary
  onChange: (value: string) => void
  onCommit: (dir?: "down" | "right") => void
  onCancel: () => void
}) {
  const { col, value, t } = props
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null)
  // Enter/Tab/Escape finish the edit; the blur that follows when the editor unmounts must not save again.
  const finished = useRef(false)
  const finish = (fn: () => void) => {
    if (finished.current) return
    finished.current = true
    fn()
  }
  useEffect(() => {
    ref.current?.focus()
    if (ref.current && "setSelectionRange" in ref.current && col.kind !== "select" && value.length > 1) ref.current.select()
  }, [col.kind, value.length])
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      finish(() => props.onCommit("down"))
    } else if (event.key === "Tab") {
      event.preventDefault()
      finish(() => props.onCommit("right"))
    } else if (event.key === "Escape") {
      event.preventDefault()
      finish(props.onCancel)
    }
  }
  const className = "absolute inset-0 z-10 h-full w-full min-w-0 rounded-none border-0 bg-[#1d1520] px-3 text-[13px] text-foreground outline-2 -outline-offset-2 outline-primary"
  if (col.kind === "select") {
    const options =
      col.key === "department"
        ? props.departments.map((d) => [d.id, d.name] as const)
        : col.key === "status"
          ? STATUSES.map((s) => [s, t.sheet.employeeStatus[s]] as const)
          : CURRENCIES.map((c) => [c, c] as const)
    return (
      <select ref={ref} value={value} onChange={(e) => props.onChange(e.target.value)} onBlur={() => finish(() => props.onCommit())} onKeyDown={onKeyDown} className={className}>
        {col.key === "department" && !value && <option value="">—</option>}
        {options.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
    )
  }
  return (
    <input
      ref={ref}
      value={value}
      type={col.kind === "date" ? "date" : "text"}
      inputMode={col.kind === "money" ? "decimal" : undefined}
      placeholder={col.kind === "wallet" ? "TRC20 / ERC20 address" : undefined}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={() => finish(() => props.onCommit())}
      onKeyDown={onKeyDown}
      className={cn(className, col.money && "text-right font-mono", "[color-scheme:dark]")}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-2xl bg-[#141015] p-6 shadow-2xl ring-1 ring-primary/25" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-4 font-display text-lg font-bold uppercase">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

const MODELS: RuleModel[] = ["NONE", "PCT_ABOVE_KPI", "PCT_OF_PROFIT", "PCT_IF_KPI_MET", "BONUS_IF_KPI_MET", "PCT_OF_BASE", "TIERED"]

function TermsDialog({ row, monthTitle, t, onClose, onSave }: { row: SheetRow; monthTitle: string; t: Dictionary; onClose: () => void; onSave: (c: RuleConfig) => Promise<void> }) {
  const [config, setConfig] = useState<RuleConfig>(row.rule.model === "NONE" ? { model: "PCT_ABOVE_KPI", ratePct: "10" } : row.rule)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<RuleConfig>) => setConfig((c) => ({ ...c, ...patch }))
  const tiers = config.tiers ?? []
  return (
    <Modal title={`${t.sheet.terms.title} · ${row.name}`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setSaving(true)
          const norm = (v?: string | null) => (v ? (normalizeNumber(v) ?? v) : v)
          await onSave({ ...config, ratePct: norm(config.ratePct), fixedAmount: norm(config.fixedAmount), capAmount: norm(config.capAmount), tiers: tiers.map((x) => ({ from: norm(x.from) ?? "", to: norm(x.to), ratePct: norm(x.ratePct) ?? "" })) })
          setSaving(false)
        }}
      >
        <p className="text-xs text-muted-foreground">{fill(t.sheet.terms.from, { month: monthTitle })}</p>
        <Labeled label={t.sheet.terms.model}>
          <Select value={config.model} onChange={(e) => set({ model: e.target.value as RuleModel })}>
            {MODELS.map((m) => (
              <option key={m} value={m}>{t.sheet.terms.models[m]}</option>
            ))}
          </Select>
        </Labeled>
        {["PCT_ABOVE_KPI", "PCT_OF_PROFIT", "PCT_IF_KPI_MET", "PCT_OF_BASE"].includes(config.model) && (
          <Labeled label={t.sheet.terms.rate}>
            <Input value={config.ratePct ?? ""} onChange={(e) => set({ ratePct: e.target.value })} inputMode="decimal" required autoFocus />
          </Labeled>
        )}
        {config.model === "BONUS_IF_KPI_MET" && (
          <Labeled label={t.sheet.terms.fixedAmount}>
            <Input value={config.fixedAmount ?? ""} onChange={(e) => set({ fixedAmount: e.target.value })} inputMode="decimal" required />
          </Labeled>
        )}
        {config.model === "TIERED" && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t.sheet.terms.tiers}</span>
            {tiers.map((tier, i) => (
              <div key={i} className="grid grid-cols-3 gap-2">
                {(["from", "to", "ratePct"] as const).map((k) => (
                  <Input key={k} value={tier[k] ?? ""} placeholder={k === "ratePct" ? "%" : k === "to" ? "∞" : "0"} inputMode="decimal" onChange={(e) => set({ tiers: tiers.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)) })} />
                ))}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => set({ tiers: [...tiers, { from: tiers.at(-1)?.to ?? "0", to: "", ratePct: "" }] })}>
              <Plus /> {t.sheet.terms.addTier}
            </Button>
          </div>
        )}
        {config.model !== "NONE" && (
          <Labeled label={t.sheet.terms.cap}>
            <Input value={config.capAmount ?? ""} onChange={(e) => set({ capAmount: e.target.value })} inputMode="decimal" />
          </Labeled>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" disabled={saving}>{saving ? t.common.saving : t.common.save}</Button>
        </div>
      </form>
    </Modal>
  )
}

function PaymentDialog(props: {
  row: SheetRow
  accounts: { id: string; name: string; currency: string }[]
  locale: Locale
  t: Dictionary
  onClose: () => void
  onSave: (input: { amount: string; currency: string; fxRate: string; fee: string; financialAccountId: string; paidAt: string; reference: string }) => Promise<void>
}) {
  const { row, t } = props
  const [form, setForm] = useState({
    amount: row.outstanding ?? "",
    currency: props.accounts[0]?.currency ?? row.currency,
    fxRate: "1",
    fee: "",
    financialAccountId: props.accounts[0]?.id ?? "",
    paidAt: new Date().toISOString().slice(0, 10),
    reference: "",
  })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  if (!row.wallet) {
    return (
      <Modal title={fill(t.sheet.payment.title, { name: row.name })} onClose={props.onClose}>
        <p className="text-sm text-muted-foreground">{t.sheet.payment.noWallet}</p>
      </Modal>
    )
  }
  return (
    <Modal title={fill(t.sheet.payment.title, { name: row.name })} onClose={props.onClose}>
      {props.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t.sheet.payment.noAccounts}{" "}
          <Link href="/accounts" className="text-primary hover:underline">{t.nav.accounts} →</Link>
        </p>
      ) : (
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setSaving(true)
            await props.onSave({ ...form, amount: normalizeNumber(form.amount) ?? form.amount, fee: normalizeNumber(form.fee) ?? form.fee, fxRate: normalizeNumber(form.fxRate) ?? form.fxRate })
            setSaving(false)
          }}
        >
          <p className="col-span-2 text-sm text-muted-foreground">
            {fill(t.sheet.payment.outstanding, { amount: formatAmount(row.outstanding, row.currency, props.locale) })} · {row.wallet.masked} {row.wallet.network}
          </p>
          <Labeled label={t.sheet.payment.amount}>
            <Input value={form.amount} onChange={set("amount")} inputMode="decimal" required autoFocus />
          </Labeled>
          <Labeled label={t.sheet.payment.currency}>
            <Select value={form.currency} onChange={set("currency")}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Labeled>
          <Labeled label={t.sheet.payment.account}>
            <Select value={form.financialAccountId} onChange={set("financialAccountId")}>
              {props.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
            </Select>
          </Labeled>
          <Labeled label={t.sheet.payment.fxRate}>
            <Input value={form.fxRate} onChange={set("fxRate")} inputMode="decimal" />
          </Labeled>
          <Labeled label={t.sheet.payment.fee}>
            <Input value={form.fee} onChange={set("fee")} inputMode="decimal" placeholder="0" />
          </Labeled>
          <Labeled label={t.sheet.payment.date}>
            <Input type="date" value={form.paidAt} onChange={set("paidAt")} required />
          </Labeled>
          <div className="col-span-2">
            <Labeled label={t.sheet.payment.reference}>
              <Input value={form.reference} onChange={set("reference")} maxLength={200} />
            </Labeled>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={props.onClose}>{t.common.cancel}</Button>
            <Button type="submit" disabled={saving}>{saving ? t.common.saving : t.sheet.payment.submit}</Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

type HistoryData = Extract<Awaited<ReturnType<typeof historyAction>>, { ok: true }>["history"]

function HistoryDialog({ row, locale, t, onClose }: { row: SheetRow; locale: Locale; t: Dictionary; onClose: () => void }) {
  const [data, setData] = useState<HistoryData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    historyAction(row.employeeId).then((r) => (r.ok ? setData(r.history) : setError(r.message)))
  }, [row.employeeId])
  return (
    <Modal title={fill(t.sheet.historyTitle, { name: row.name })} onClose={onClose}>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">{t.common.loading}</p>}
      {data && (
        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto text-sm">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{t.sheet.salaryHistory}</h3>
            {data.salaries.map((s) => (
              <div key={s.from} className="flex justify-between border-b border-border/50 py-1.5">
                <span className="text-muted-foreground">{formatDate(s.from, locale)} – {s.to ? formatDate(s.to, locale) : "…"}</span>
                <span className="font-mono">{formatAmount(s.amount, s.currency, locale)}{!s.approved && " ⚠"}</span>
              </div>
            ))}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{t.sheet.termsHistory}</h3>
            {data.rules.length === 0 && <p className="text-muted-foreground">{t.sheet.terms.models.NONE}</p>}
            {data.rules.map((r) => (
              <div key={r.from} className="flex justify-between gap-4 border-b border-border/50 py-1.5">
                <span className="text-muted-foreground">{formatDate(r.from, locale)} – {r.to ? formatDate(r.to, locale) : "…"}</span>
                <span>{r.terms}</span>
              </div>
            ))}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{t.sheet.payslips}</h3>
            {data.payslips.length === 0 && <p className="text-muted-foreground">{t.common.noData}</p>}
            {data.payslips.map((p) => (
              <div key={p.month} className="flex justify-between border-b border-border/50 py-1.5">
                <span className="text-muted-foreground">{p.month} · {p.status.toLowerCase()}</span>
                <span className="font-mono">{formatAmount(p.net, p.currency, locale)} / {formatAmount(p.paid, p.currency, locale)}</span>
              </div>
            ))}
          </section>
        </div>
      )}
    </Modal>
  )
}

/** The empty row under the table: type a name, department and FIX, press Enter. */
function AddEmployee({ monthKey, departments, t, hint, toast, onDone }: { monthKey: string; departments: { id: string; name: string }[]; t: Dictionary; hint: string; toast: (text: string, tone?: "ok" | "error") => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: "", departmentId: departments[0]?.id ?? "", fix: "", currency: "USD", hireDate: "" })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <form
      className="-mt-3 flex flex-wrap items-end gap-2 rounded-b-2xl border border-t-0 border-dashed border-primary/30 bg-card/30 px-3 py-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const fix = normalizeNumber(form.fix)
        if (!fix) return toast(`${t.sheet.add.fix}?`, "error")
        setSaving(true)
        const result = await addEmployeeAction(monthKey, { ...form, fix })
        setSaving(false)
        if (!result.ok) return toast(result.message, "error")
        setForm((f) => ({ ...f, name: "", fix: "", hireDate: "" }))
        toast(t.sheet.rowsSaved)
        onDone()
      }}
    >
      <p className="w-full text-[11px] text-muted-foreground"><Plus className="mr-1 inline size-3 text-primary" />{hint}</p>
      <Labeled label={t.sheet.add.name}>
        <Input id="sheet-new-employee" value={form.name} onChange={set("name")} required maxLength={160} className="h-8 w-52" />
      </Labeled>
      <Labeled label={t.sheet.add.department}>
        <Select value={form.departmentId} onChange={set("departmentId")} required className="w-52">
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Labeled>
      <Labeled label={t.sheet.add.fix}>
        <Input value={form.fix} onChange={set("fix")} required inputMode="decimal" className="w-28" />
      </Labeled>
      <Labeled label={t.sheet.add.currency}>
        <Select value={form.currency} onChange={set("currency")} className="w-24">
          {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </Select>
      </Labeled>
      <Labeled label={t.sheet.add.startDate}>
        <Input type="date" value={form.hireDate} onChange={set("hireDate")} className="w-40" />
      </Labeled>
      <Button type="submit" disabled={saving} className="h-9">
        <Plus /> {saving ? t.common.saving : t.common.add}
      </Button>
    </form>
  )
}
