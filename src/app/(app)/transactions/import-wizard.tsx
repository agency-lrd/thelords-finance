"use client"

import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from "lucide-react"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/form-controls"
import type { transactionOptions } from "@/lib/data/transactions"
import { formatAmount, type Locale } from "@/lib/i18n/format"
import { importTexts, type ImportTexts } from "@/lib/i18n/imports"
import { transactionTexts } from "@/lib/i18n/transactions"
import { IMPORT_FIELDS, MAIN_FIELDS, WARNING_CODES, type ImportField, type ImportSettings, type ImportSummary, type Issue, type RowCheck } from "@/lib/imports/fields"
import { suggestMapping } from "@/lib/imports/mapping"
import { toCsv } from "@/lib/xlsx"

import { cancelImportAction, commitImportAction, importHistoryAction, validateImportAction } from "./actions"

type Options = Awaited<ReturnType<typeof transactionOptions>>
type Upload = {
  batchId: string
  fileName: string
  format: "CSV" | "XLSX"
  encoding: string | null
  delimiter: string | null
  rowCount: number
  sample: string[][]
  columns: number
  settings: ImportSettings
  previousImports: { id: string; at: string; created: number; status: string }[]
}
type Result = { status: "IMPORTED" | "PARTIAL" | "FAILED"; created: number; duplicates: number; excluded: number; failed: number; outcomes: { row: number; outcome: string; number?: number; message?: string }[] }
type History = { id: string; fileName: string; format: string; rowCount: number; status: string; createdCount: number; duplicateCount: number; errorCount: number; createdAt: string; createdBy: string }[]

const REQUIRED: ImportField[] = ["date", "amount", "description", "type"]
const MANUAL_TYPES = ["REFUND", "ADJUSTMENT"]
const INCOME = ["REVENUE"]
const EXPENSE = ["OPERATING_EXPENSE", "PAYROLL", "TAX_PAYMENT", "ASSET_PURCHASE"]
const letter = (i: number) => {
  let n = i + 1
  let s = ""
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}
const fillText = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""))

function issueText(t: ImportTexts, i: Issue) {
  return fillText(t.issue[i.code] ?? i.code, { value: i.value ?? "" })
}

/** Five-step import: file → columns → check → confirm → result. Writes only drafts, after confirmation. */
export function ImportWizard({ locale, options, onClose, onImported }: { locale: Locale; options: Options; onClose: () => void; onImported: () => void }) {
  const t = importTexts[locale]
  const types = transactionTexts[locale].types
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [upload, setUpload] = useState<Upload | null>(null)
  const [settings, setSettings] = useState<ImportSettings | null>(null)
  const [csv, setCsv] = useState<{ encoding: string; delimiter: string }>({ encoding: "", delimiter: "" })
  const [rows, setRows] = useState<RowCheck[]>([])
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [include, setInclude] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState<"all" | RowCheck["status"]>("all")
  const [checked, setChecked] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<History>([])
  const [dragging, setDragging] = useState(false)

  const loadHistory = async () => {
    const r = await importHistoryAction().catch(() => null)
    if (r && r.ok) setHistory(r.batches as History)
  }
  useEffect(() => {
    let active = true
    importHistoryAction()
      .then((r) => {
        if (active && r.ok) setHistory(r.batches as History)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  async function send(f: File, overrides: { encoding?: string; delimiter?: string } = {}) {
    setError(null)
    if (!/\.(xlsx|csv|txt)$/i.test(f.name)) return setError(/\.xls$/i.test(f.name) ? t.fileError.legacy_xls : t.fileError.unsupported)
    if (f.size > 4_000_000) return setError(t.fileError.too_large)
    setBusy(t.uploading)
    try {
      const body = new FormData()
      body.set("file", f)
      if (overrides.encoding) body.set("encoding", overrides.encoding)
      if (overrides.delimiter) body.set("delimiter", overrides.delimiter)
      const res = await fetch("/api/transactions/import", { method: "POST", body })
      const data = (await res.json().catch(() => ({ error: "internal" }))) as Upload & { error?: string }
      if (!res.ok || data.error) return setError(t.fileError[data.error ?? "internal"] ?? t.fileError.internal)
      if (upload && upload.batchId !== data.batchId) await cancelImportAction(upload.batchId).catch(() => null)
      setFile(f)
      setUpload(data)
      setSettings(data.settings)
      setCsv({ encoding: data.encoding ?? "", delimiter: data.delimiter ?? "" })
      setRows([])
      setSummary(null)
      setStep(1)
    } catch {
      setError(t.fileError.network)
    } finally {
      setBusy(null)
    }
  }

  async function validate() {
    if (!upload || !settings) return
    setError(null)
    setBusy(t.validating)
    try {
      const r = await validateImportAction(upload.batchId, settings)
      if (!r.ok) return setError(r.message)
      if (r.missing.length) return setError(fillText(t.missing, { fields: r.missing.map((f) => t.field[f as ImportField]).join(", ") }))
      setRows(r.rows)
      setSummary(r.summary)
      setInclude(new Set(r.rows.filter((x) => x.include).map((x) => x.row)))
      setFilter(r.summary.errors ? "error" : "all")
      setStep(2)
    } catch {
      setError(t.fileError.network)
    } finally {
      setBusy(null)
    }
  }

  async function commit() {
    if (!upload || !settings) return
    setError(null)
    setBusy(t.importing)
    try {
      const r = await commitImportAction(upload.batchId, settings, [...include], true)
      if (!r.ok) return setError(r.message)
      setResult(r.result as Result)
      setStep(4)
      onImported()
      loadHistory()
    } catch {
      setError(t.fileError.network)
    } finally {
      setBusy(null)
    }
  }

  async function cancel() {
    if (upload && step < 4) await cancelImportAction(upload.batchId).catch(() => null)
    reset()
    onClose()
  }

  function reset() {
    setStep(0)
    setFile(null)
    setUpload(null)
    setSettings(null)
    setRows([])
    setSummary(null)
    setResult(null)
    setChecked(false)
    setError(null)
  }

  function downloadTemplate() {
    const blob = new Blob([toCsv(t.templateRows)], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement("a"), { href: url, download: locale === "ru" ? "шаблон-импорта-транзакций.csv" : "transactions-import-template.csv" }).click()
    URL.revokeObjectURL(url)
  }

  const selected = useMemo(() => rows.filter((r) => include.has(r.row) && (r.status === "ok" || r.status === "warning" || (r.status === "duplicate" && !r.issues.some((i) => i.code === "already_imported")))), [rows, include])
  const totals = useMemo(() => {
    const map = new Map<string, { income: number; expense: number; other: number }>()
    for (const r of selected) {
      if (!r.preview) continue
      const x = map.get(r.preview.currency) ?? { income: 0, expense: 0, other: 0 }
      const amount = Number(r.preview.amount)
      if (INCOME.includes(r.preview.type)) x.income += amount
      else if (EXPENSE.includes(r.preview.type)) x.expense += amount
      else x.other += amount
      map.set(r.preview.currency, x)
    }
    return [...map.entries()]
  }, [selected])
  const shown = rows.filter((r) => filter === "all" || r.status === filter)
  const money = (v: number, c: string) => formatAmount(v.toFixed(2), c, locale)
  const setMap = (field: ImportField, value: string) => setSettings((s) => (s ? { ...s, mapping: { ...s.mapping, [field]: value === "" ? undefined : Number(value) } } : s))
  const header = upload && settings ? upload.sample[settings.headerRow] ?? [] : []
  const columnLabel = (i: number) => `${letter(i)}${header[i] ? ` · ${header[i].slice(0, 30)}` : upload?.sample[(settings?.headerRow ?? 0) + 1]?.[i] ? ` · ${upload.sample[(settings?.headerRow ?? 0) + 1][i].slice(0, 20)}` : ""}`
  const selectable = (r: RowCheck) => r.status !== "error" && !r.issues.some((i) => i.code === "already_imported")

  const fieldRow = (f: ImportField) => (
    <label key={f} className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      <span>
        {t.field[f]} {REQUIRED.includes(f) && <span className="text-primary">*</span>}
      </span>
      <Select value={settings?.mapping[f] ?? ""} onChange={(e) => setMap(f, e.target.value)} className="h-8 text-xs">
        <option value="">{t.notMapped}</option>
        {Array.from({ length: upload?.columns ?? 0 }, (_, i) => (
          <option key={i} value={i}>
            {columnLabel(i)}
          </option>
        ))}
      </Select>
    </label>
  )

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-card/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 font-display text-lg font-black uppercase italic"><FileSpreadsheet className="size-5 text-primary" /> {t.title}</h2>
        <ol className="ml-auto flex flex-wrap gap-1 text-[11px]">
          {t.steps.map((s, i) => (
            <li key={s} className={cn("rounded-full border px-2.5 py-0.5", i === step ? "border-primary bg-primary/15 text-primary" : i < step ? "border-border text-foreground/80" : "border-border/50 text-muted-foreground")}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
        <button type="button" onClick={cancel} aria-label={t.cancel} className="rounded-lg p-1 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>

      {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</p>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin text-primary" /> {busy}</p>}

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const f = e.dataTransfer.files?.[0]
              if (f) send(f)
            }}
            className={cn("flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-8 text-center", dragging ? "border-primary bg-primary/10" : "border-border")}
          >
            <Upload className="size-8 text-primary" />
            <p className="text-sm">{t.drop}</p>
            <input
              ref={input}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ""
                if (f) send(f)
              }}
            />
            <Button type="button" onClick={() => input.current?.click()} disabled={!!busy}>
              <Upload /> {t.choose}
            </Button>
            <p className="max-w-xl text-[11px] text-muted-foreground">{t.limits}</p>
            <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><Download className="size-3.5" /> {t.template}</button>
          </div>
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.history}</p>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.noHistory}</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-t border-border/40">
                      <td className="py-1.5">{h.createdAt.slice(0, 16).replace("T", " ")}</td>
                      <td className="py-1.5">{h.fileName}</td>
                      <td className="py-1.5 text-muted-foreground">{h.rowCount} {t.rows}</td>
                      <td className="py-1.5">{t.historyStatus[h.status as keyof ImportTexts["historyStatus"]] ?? h.status}</td>
                      <td className="py-1.5 text-right text-muted-foreground">+{h.createdCount} · {t.result.duplicates.toLowerCase()} {h.duplicateCount}{h.errorCount ? ` · ${t.result.failed.toLowerCase()} ${h.errorCount}` : ""}</td>
                      <td className="py-1.5 text-right text-muted-foreground">{h.createdBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {step === 1 && upload && settings && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <p className="text-sm">
              {t.file}: <span className="font-medium">{upload.fileName}</span> <span className="text-muted-foreground">({upload.format}, {upload.rowCount} {t.rows})</span>
            </p>
            {upload.format === "CSV" && file && (
              <>
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  {t.encoding}
                  <Select value={csv.encoding} onChange={(e) => setCsv((c) => ({ ...c, encoding: e.target.value }))} className="h-8 w-36 text-xs">
                    {["utf-8", "windows-1251", "utf-16le", "utf-16be"].map((x) => <option key={x}>{x}</option>)}
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  {t.delimiter}
                  <Select value={csv.delimiter} onChange={(e) => setCsv((c) => ({ ...c, delimiter: e.target.value }))} className="h-8 w-28 text-xs">
                    {[",", ";", "\t", "|"].map((x) => <option key={x} value={x}>{x === "\t" ? "Tab" : x}</option>)}
                  </Select>
                </label>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => send(file, csv)}>{t.reread}</Button>
              </>
            )}
          </div>
          {upload.previousImports.length > 0 && <p className="rounded-xl border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">{fillText(t.sameFile, { date: upload.previousImports[0].at.slice(0, 10), n: upload.previousImports[0].created })}</p>}

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t.headerRow}
              <Select
                value={settings.headerRow}
                onChange={(e) => {
                  const headerRow = Number(e.target.value)
                  setSettings({ ...settings, headerRow, mapping: suggestMapping(upload.sample[headerRow] ?? []) })
                }}
                className="h-8 text-xs"
              >
                {upload.sample.slice(0, 15).map((r, i) => <option key={i} value={i}>{i + 1}: {r.filter(Boolean).slice(0, 3).join(" | ").slice(0, 50)}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t.dateFormat}
              <Select value={settings.dateFormat} onChange={(e) => setSettings({ ...settings, dateFormat: e.target.value as ImportSettings["dateFormat"] })} className="h-8 text-xs">
                <option value="auto">{t.auto}</option>
                <option value="DMY">{t.dmy}</option>
                <option value="MDY">{t.mdy}</option>
                <option value="YMD">{t.ymd}</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t.decimal}
              <Select value={settings.decimal} onChange={(e) => setSettings({ ...settings, decimal: e.target.value as ImportSettings["decimal"] })} className="h-8 text-xs">
                <option value="auto">{t.auto}</option>
                <option value=".">{t.dot}</option>
                <option value=",">{t.comma}</option>
              </Select>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.mapping}</p>
            <p className="text-xs text-muted-foreground">{t.mappingHint}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{MAIN_FIELDS.map(fieldRow)}</div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t.more}</summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{IMPORT_FIELDS.filter((f) => !MAIN_FIELDS.includes(f)).map(fieldRow)}</div>
            </details>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.defaults}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {t.defaultType}
                <Select value={settings.defaults.type ?? ""} onChange={(e) => setSettings({ ...settings, defaults: { ...settings.defaults, type: e.target.value || null } })} className="h-8 text-xs">
                  <option value="">{t.none}</option>
                  {Object.entries(types).filter(([k]) => !MANUAL_TYPES.includes(k)).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {t.defaultCurrency}
                <Select value={settings.defaults.currency ?? ""} onChange={(e) => setSettings({ ...settings, defaults: { ...settings.defaults, currency: e.target.value || null } })} className="h-8 text-xs">
                  <option value="">{t.none}</option>
                  {["USD", "EUR", "GBP", "USDT"].map((c) => <option key={c}>{c}</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {t.defaultAccount}
                <Select value={settings.defaults.account ?? ""} onChange={(e) => setSettings({ ...settings, defaults: { ...settings.defaults, account: e.target.value || null } })} className="h-8 text-xs">
                  <option value="">{t.none}</option>
                  {options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                {t.defaultCategory}
                <Select value={settings.defaults.category ?? ""} onChange={(e) => setSettings({ ...settings, defaults: { ...settings.defaults, category: e.target.value || null } })} className="h-8 text-xs">
                  <option value="">{t.none}</option>
                  {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </label>
            </div>
            <p className="text-[11px] text-amber-200/80">{t.typeWarning}</p>
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.preview}</p>
            <div className="max-h-64 overflow-auto rounded-xl border border-border/60">
              <table className="w-full text-xs">
                <tbody>
                  {upload.sample.slice(settings.headerRow, settings.headerRow + 11).map((r, i) => (
                    <tr key={i} className={cn("border-t border-border/40 first:border-0", i === 0 && "bg-muted/30 font-semibold")}>
                      <td className="px-2 py-1 text-muted-foreground">{settings.headerRow + i + 1}</td>
                      {Array.from({ length: upload.columns }, (_, c) => <td key={c} className="max-w-48 truncate px-2 py-1">{r[c] ?? ""}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={reset}>{t.back}</Button>
            <Button onClick={validate} disabled={!!busy}>{t.check}</Button>
          </div>
        </div>
      )}

      {step === 2 && summary && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["rows", summary.rows],
                ["valid", summary.valid],
                ["warnings", summary.warnings],
                ["errors", summary.errors],
                ["duplicates", summary.duplicates],
                ["selected", selected.length],
              ] as const
            ).map(([k, n]) => (
              <div key={k} className={cn("rounded-xl border p-3", k === "errors" && n ? "border-red-400/40" : k === "selected" ? "border-primary/50" : "border-border")}>
                <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t.summary[k]}</p>
                <p className="font-display text-xl font-black">{n}</p>
              </div>
            ))}
          </div>
          {totals.length > 0 && (
            <div className="text-xs">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.totals}</p>
              {totals.map(([c, x]) => (
                <p key={c} className="font-mono">
                  {c}: {t.income} {money(x.income, c)} · {t.expense} {money(x.expense, c)} · {t.other} {money(x.other, c)}
                </p>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {(["all", "error", "duplicate", "warning", "ok"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded-full border px-3 py-1", filter === f ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground")}>
                {t.filter[f]} ({f === "all" ? rows.length : rows.filter((r) => r.status === f).length})
              </button>
            ))}
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setInclude(new Set(rows.filter((r) => r.status === "ok" || r.status === "warning").map((r) => r.row)))}>{t.selectValid}</Button>
              <Button size="sm" variant="ghost" onClick={() => setInclude(new Set())}>{t.selectNone}</Button>
            </span>
          </div>
          <div className="max-h-[28rem] overflow-auto rounded-xl border border-border/60">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">{t.col.include}</th>
                  <th className="px-2 py-1.5 text-left">{t.col.row}</th>
                  <th className="px-2 py-1.5 text-left">{t.col.status}</th>
                  <th className="px-2 py-1.5 text-left">{t.field.date}</th>
                  <th className="px-2 py-1.5 text-left">{t.field.description}</th>
                  <th className="px-2 py-1.5 text-right">{t.field.amount}</th>
                  <th className="px-2 py-1.5 text-left">{t.field.type}</th>
                  <th className="px-2 py-1.5 text-left">{t.field.account} / {t.field.category}</th>
                  <th className="px-2 py-1.5 text-left">{t.col.issues}</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((r) => (
                  <tr key={r.row} className={cn("border-t border-border/40 align-top", r.status === "error" && "bg-red-500/5")}>
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`${t.col.include} ${r.row}`}
                        disabled={!selectable(r)}
                        checked={include.has(r.row) && selectable(r)}
                        onChange={(e) => setInclude((s) => {
                          const next = new Set(s)
                          if (e.target.checked) next.add(r.row)
                          else next.delete(r.row)
                          return next
                        })}
                        className="accent-[var(--primary)]"
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.row}</td>
                    <td className="px-2 py-1.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px]", r.status === "error" ? "bg-red-500/20 text-red-300" : r.status === "duplicate" ? "bg-amber-500/20 text-amber-300" : r.status === "warning" ? "bg-amber-500/10 text-amber-200" : "bg-emerald-500/15 text-emerald-300")}>{t.status[r.status]}</span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.preview?.date ?? "—"}</td>
                    <td className="max-w-64 truncate px-2 py-1.5" title={r.preview?.description}>{r.preview?.description ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap">{r.preview ? money(Number(r.preview.amount), r.preview.currency) : "—"}</td>
                    <td className="px-2 py-1.5">{r.preview?.type ? (types as Record<string, string>)[r.preview.type] ?? r.preview.type : "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{[r.preview?.account, r.preview?.category].filter(Boolean).join(" / ") || "—"}</td>
                    <td className="px-2 py-1.5">
                      {r.issues.map((i, n) => (
                        <p key={n} className={cn(WARNING_CODES.includes(i.code) || i.code === "duplicate_in_file" || i.code === "already_imported" ? "text-amber-200" : "text-red-300")}>
                          {issueText(t, i)}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 500 && <p className="text-[11px] text-muted-foreground">{fillText(t.shown, { shown: 500, total: shown.length })}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setStep(1)}>{t.back}</Button>
            <Button onClick={() => setStep(3)} disabled={selected.length === 0}>{t.next}</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-3">
          <p className="font-medium">{t.confirmTitle}</p>
          <p className="text-sm text-muted-foreground">{fillText(t.confirmText, { n: selected.length })}</p>
          {totals.map(([c, x]) => (
            <p key={c} className="font-mono text-xs">
              {c}: {t.income} {money(x.income, c)} · {t.expense} {money(x.expense, c)} · {t.other} {money(x.other, c)}
            </p>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="accent-[var(--primary)]" />
            {t.confirmCheck}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setStep(2)}>{t.back}</Button>
            <Button onClick={commit} disabled={!checked || !!busy || selected.length === 0}>{fillText(t.confirm, { n: selected.length })}</Button>
          </div>
        </div>
      )}

      {step === 4 && result && (
        <div className="flex flex-col gap-3">
          <p className={cn("flex items-center gap-2 font-medium", result.status === "IMPORTED" ? "text-emerald-300" : "text-amber-300")}>
            {result.status === "IMPORTED" ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />} {t.resultStatus[result.status]}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ["created", result.created],
                ["duplicates", result.duplicates],
                ["excluded", result.excluded],
                ["failed", result.failed],
              ] as const
            ).map(([k, n]) => (
              <div key={k} className={cn("rounded-xl border p-3", k === "failed" && n ? "border-red-400/40" : "border-border")}>
                <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t.result[k]}</p>
                <p className="font-display text-xl font-black">{n}</p>
              </div>
            ))}
          </div>
          {result.failed > 0 && (
            <div className="text-xs">
              <p className="mb-1 font-medium">{t.failedRows}</p>
              {result.outcomes.filter((o) => o.outcome === "failed").slice(0, 50).map((o) => (
                <p key={o.row} className="text-red-300">{t.col.row} {o.row}: {o.message}</p>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {result.status !== "IMPORTED" && <Button onClick={commit} disabled={!!busy}>{t.retry}</Button>}
            <Link href="/transactions?status=DRAFT" className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted">{t.openDrafts}</Link>
            <Button variant="outline" onClick={reset}>{t.newImport}</Button>
          </div>
        </div>
      )}
    </div>
  )
}
