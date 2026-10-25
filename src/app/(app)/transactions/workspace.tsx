"use client"

import { Download, Paperclip, Plus, Rows3, Scale, Search, Upload } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select, Textarea } from "@/components/ui/form-controls"
import type { listTransactions, transactionOptions } from "@/lib/data/transactions"
import { fill } from "@/lib/i18n/dictionaries"
import { formatAmount, formatDate, normalizeNumber, type Locale } from "@/lib/i18n/format"
import { transactionTexts, type TransactionTexts } from "@/lib/i18n/transactions"
import { toCsv, writeXlsx } from "@/lib/xlsx"

import { MovementDialog } from "@/components/finance/movement-dialog"
import { PeriodPicker } from "@/components/reports/period-picker"
import type { listSalaryPayments } from "@/lib/data/cash-register"
import { KIND_LABELS } from "@/lib/transactions/kinds"

import { ImportWizard } from "./import-wizard"
import { deleteDraftAction, importAction, postAction, reverseAction, saveTransactionAction, settleAction, type TransactionForm } from "./actions"

type Row = Awaited<ReturnType<typeof listTransactions>>[number]
type Options = Awaited<ReturnType<typeof transactionOptions>>

type Props = {
  locale: Locale
  baseCurrency: string
  rows: Row[]
  options: Options
  balances: { id: string; name: string; currency: string; balance: string }[]
  filters: Record<"from" | "to" | "type" | "status" | "account" | "dept" | "category" | "q", string>
  perms: { create: boolean; post: boolean; paySalary: boolean }
  /** Month chosen in the period picker ("" = no month: all dates or the from/to filter). */
  month: string
  salaryPayments: Awaited<ReturnType<typeof listSalaryPayments>>
}

const TYPES = Object.keys(transactionTexts.ru.types) as (keyof TransactionTexts["types"])[]
const CURRENCIES = ["USD", "USDT", "EUR", "GBP"]
const today = () => new Date().toISOString().slice(0, 10)

const emptyForm = (accountId = ""): TransactionForm => ({
  type: "OPERATING_EXPENSE", date: today(), description: "", amount: "", currency: "USD", fxRate: "", fee: "", financialAccountId: accountId,
  counterFinancialAccountId: "", categoryId: "", debitAccountId: "", creditAccountId: "", departmentId: "", clientId: "", projectId: "",
  shareholderId: "", counterparty: "", direction: "", settlementStatus: "PAID", dueDate: "", notes: "", attachmentUrl: "",
})

const fromRow = (r: Row): TransactionForm => ({
  type: r.type, date: r.date, description: r.description, amount: r.amount, currency: r.currency, fxRate: r.currency === "USD" ? "" : r.fxRate, fee: r.fee === "0" ? "" : r.fee,
  financialAccountId: r.financialAccountId ?? "", counterFinancialAccountId: r.counterFinancialAccountId ?? "", categoryId: r.categoryId ?? "",
  debitAccountId: r.debitAccountId ?? "", creditAccountId: r.creditAccountId ?? "", departmentId: r.departmentId ?? "", clientId: r.clientId ?? "",
  projectId: r.projectId ?? "", shareholderId: r.shareholderId ?? "", counterparty: r.counterparty ?? "", direction: r.direction ?? "",
  settlementStatus: r.settlementStatus === "PAID" ? "PAID" : "UNPAID", dueDate: r.dueDate ?? "", notes: r.notes ?? "", attachmentUrl: r.attachmentUrl ?? "",
})

export function TransactionsWorkspace(props: Props) {
  const { locale, rows, options, perms } = props
  const t = transactionTexts[locale]
  const router = useRouter()
  const [, startRefresh] = useTransition()
  const [editing, setEditing] = useState<{ row: Row | null; form: TransactionForm } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [panel, setPanel] = useState<"none" | "bulk" | "import" | "reconcile">("none")
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(null)
  const [busy, setBusy] = useState(false)
  const [movement, setMovement] = useState(false)
  const kindLabel = KIND_LABELS[locale]
  const merged = useMemo(
    () =>
      [...rows.map((r) => ({ key: r.id, date: r.date, tx: r, pay: null })), ...props.salaryPayments.map((p) => ({ key: `pay-${p.id}`, date: p.date, tx: null, pay: p }))].sort((a, b) => b.date.localeCompare(a.date)),
    [rows, props.salaryPayments],
  )
  const refresh = () => startRefresh(() => router.refresh())
  const money = (v: string, c: string) => formatAmount(v, c, locale)
  const drafts = rows.filter((r) => r.status === "DRAFT")

  async function run<T extends { ok: boolean; message?: string }>(fn: () => Promise<T>, success?: (r: T) => string | undefined) {
    setBusy(true)
    setMessage(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setMessage({ text: r.message ?? "Error", tone: "error" })
    else {
      const text = success?.(r)
      if (text) setMessage({ text, tone: "ok" })
      refresh()
    }
    return r
  }

  function exportRows(kind: "csv" | "xlsx") {
    const head = [t.col.number, t.col.date, t.col.period, t.col.type, t.col.description, t.col.amount, t.col.currency, `${t.col.amount} ${props.baseCurrency}`, t.col.account, t.col.toAccount, t.col.department, t.col.category, t.col.client, t.col.project, t.col.counterparty, t.col.payment, t.col.approval, t.col.comment, t.col.attachment]
    const body = rows.map((r) => [String(r.number), r.date, r.period, t.types[r.type], r.description, r.amount, r.currency, r.baseAmount, r.financialAccount ?? "", r.counterFinancialAccount ?? "", r.department ?? "", r.category ?? "", r.client ?? "", r.project ?? "", r.counterparty ?? r.shareholder ?? "", t.settlement[r.settlementStatus], t.status[r.status], r.notes ?? "", r.attachmentUrl ?? ""])
    const blob = kind === "csv" ? new Blob([toCsv([head, ...body])], { type: "text/csv;charset=utf-8" }) : new Blob([writeXlsx([head, ...body], "Transactions").slice().buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    const url = URL.createObjectURL(blob)
    Object.assign(document.createElement("a"), { href: url, download: `transactions-${today()}.${kind}` }).click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{t.title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {perms.create && (
            <Button size="sm" onClick={() => (props.balances.length ? setMovement(true) : setMessage({ text: t.noAccount, tone: "error" }))}>
              <Plus /> {locale === "ru" ? "Записать движение денег" : "Record money movement"}
            </Button>
          )}
          {perms.create && (
            <Button size="sm" variant="outline" onClick={() => (props.balances.length ? setEditing({ row: null, form: emptyForm(props.balances[0]?.id) }) : setMessage({ text: t.noAccount, tone: "error" }))}>
              {locale === "ru" ? "Бухгалтерская запись" : "Accounting entry"}
            </Button>
          )}
          {perms.create && <Button size="sm" variant="outline" onClick={() => setPanel(panel === "bulk" ? "none" : "bulk")}><Rows3 /> {t.bulk}</Button>}
          {perms.create && <Button size="sm" variant="outline" onClick={() => setPanel(panel === "import" ? "none" : "import")}><Upload /> {t.import}</Button>}
          <Button size="sm" variant="outline" onClick={() => setPanel(panel === "reconcile" ? "none" : "reconcile")}><Scale /> {t.reconcile}</Button>
          <Button size="sm" variant="ghost" onClick={() => exportRows("csv")}><Download /> {t.exportCsv}</Button>
          <Button size="sm" variant="ghost" onClick={() => exportRows("xlsx")}><Download /> {t.exportXlsx}</Button>
        </div>
      </div>

      {message && <p role={message.tone === "error" ? "alert" : "status"} className={cn("rounded-xl border px-4 py-2 text-sm", message.tone === "error" ? "border-destructive/40 bg-destructive/10 text-red-200" : "border-primary/30 bg-primary/10")}>{message.text}</p>}
      {props.balances.length === 0 && perms.create && (
        <p className="text-sm text-muted-foreground">{t.noAccount} <Link href="/accounts" className="text-primary hover:underline">→</Link></p>
      )}

      {panel === "bulk" && <BulkEntry t={t} options={options} busy={busy} onSave={(table) => run(() => importAction(table, false), (r) => ("created" in r ? fill(t.importResult, { created: r.created, skipped: r.skipped, errors: r.errors.length }) + (r.errors.length ? ` — ${r.errors.slice(0, 3).join("; ")}` : "") : undefined))} />}
      {panel === "import" && <ImportWizard locale={locale} options={options} onClose={() => setPanel("none")} onImported={refresh} />}
      {panel === "reconcile" && <Reconcile t={t} locale={locale} baseCurrency={props.baseCurrency} balances={props.balances} />}

      <div className="flex flex-wrap items-center gap-3">
        <PeriodPicker value={props.month || new Date().toISOString().slice(0, 7)} kinds={["month"]} />
        {props.month && <Link href="/transactions" className="text-xs text-muted-foreground hover:text-primary">{locale === "ru" ? "Все даты" : "All dates"}</Link>}
      </div>
      <Filters t={t} options={options} filters={props.filters} />

      {perms.post && drafts.length > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <Button size="sm" disabled={busy || selected.size === 0} onClick={() => run(() => postAction([...selected]), (r) => fill(t.posted, { n: r.message ?? selected.size })).then(() => setSelected(new Set()))}>
            {t.postSelected}
          </Button>
          <span className="text-muted-foreground">{fill(t.selected, { n: selected.size })}</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
        <table className="w-full min-w-[1200px] text-[13px]">
          <thead className="sticky top-0 bg-[#141015] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2.5">
                {perms.post && drafts.length > 0 && (
                  <input type="checkbox" aria-label={t.postSelected} checked={selected.size === drafts.length} onChange={(e) => setSelected(e.target.checked ? new Set(drafts.map((d) => d.id)) : new Set())} className="accent-[var(--primary)]" />
                )}
              </th>
              {[t.col.number, t.col.date, t.col.type, t.col.description, t.col.amount, t.col.account, t.col.department, t.col.category, t.col.counterparty, t.col.payment, t.col.approval, ""].map((h, i) => (
                <th key={i} className={cn("px-3 py-2.5 text-left font-medium whitespace-nowrap", i === 4 && "text-right")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {merged.length === 0 && (
              <tr><td colSpan={13} className="px-4 py-14 text-center"><p className="font-medium">{t.empty}</p><p className="mt-1 text-sm text-muted-foreground">{t.emptyHint}</p></td></tr>
            )}
            {merged.map(({ key, tx: r, pay }) => !r ? (
              <tr key={key} className="border-t border-border/50" title={locale === "ru" ? "Выплата по утверждённой ведомости (финансовый лист). Одна запись: она же в Cash Flow." : "Payment of an approved payslip (financial sheet). One record, also in Cash Flow."}>
                <td className="px-2 py-2" />
                <td className="px-3 py-2 font-mono text-muted-foreground">{pay!.journalEntryNumber ? `J${pay!.journalEntryNumber}` : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(pay!.date, locale)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{kindLabel.SALARY}</td>
                <td className="max-w-72 truncate px-3 py-2">{pay!.employee} · {pay!.payrollMonth}{pay!.reference && <span className="ml-2 text-[11px] text-muted-foreground">· {pay!.reference}</span>}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{money(pay!.amount, pay!.currency)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{pay!.account ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{pay!.department ?? "—"}</td>
                <td className="px-3 py-2">{locale === "ru" ? "Зарплата" : "Payroll"}</td>
                <td className="px-3 py-2">{pay!.employee}</td>
                <td className="px-3 py-2">{t.settlement.PAID}</td>
                <td className="px-3 py-2 whitespace-nowrap"><span className="rounded-full border border-primary/50 px-2 py-0.5 text-[11px] text-primary">{pay!.status === "REVERSED" ? t.status.REVERSED : t.status.POSTED}</span></td>
                <td className="px-3 py-2" />
              </tr>
            ) : (
              <tr key={r.id} onClick={() => setEditing({ row: r, form: fromRow(r) })} className={cn("cursor-pointer border-t border-border/50 hover:bg-white/[0.03]", r.status === "REVERSED" && "text-muted-foreground line-through decoration-muted-foreground/40", r.status === "DRAFT" && "text-foreground/75")}>
                <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                  {r.status === "DRAFT" && perms.post && (
                    <input type="checkbox" aria-label={`#${r.number}`} checked={selected.has(r.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n })} className="accent-[var(--primary)]" />
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-muted-foreground">{r.number}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.date, locale)}</td>
                <td className="px-3 py-2 whitespace-nowrap" title={t.types[r.type]}>{kindLabel[r.kind]}{r.team && <span className="block text-[10px] text-muted-foreground">{r.team}</span>}</td>
                <td className="max-w-72 truncate px-3 py-2">{r.description}{r.notes && <span className="ml-2 text-[11px] text-muted-foreground">· {r.notes}</span>}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{money(r.amount, r.currency)}{r.currency !== props.baseCurrency && <span className="block text-[10px] text-muted-foreground">{money(r.baseAmount, props.baseCurrency)}</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.financialAccount ?? "—"}{r.counterFinancialAccount && ` → ${r.counterFinancialAccount}`}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.department ?? "—"}</td>
                <td className="max-w-48 truncate px-3 py-2">{r.category ?? "—"}</td>
                <td className="max-w-40 truncate px-3 py-2">{r.counterparty ?? r.shareholder ?? r.client ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap"><span className={cn(r.settlementStatus !== "PAID" && "text-amber-300")}>{t.settlement[r.settlementStatus]}</span></td>
                <td className="px-3 py-2 whitespace-nowrap"><span className={cn("rounded-full border px-2 py-0.5 text-[11px]", r.status === "POSTED" ? "border-primary/50 text-primary" : "border-border text-muted-foreground")}>{t.status[r.status]}</span></td>
                <td className="px-3 py-2">{r.attachmentUrl && <a href={r.attachmentUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={t.col.attachment}><Paperclip className="size-3.5 text-muted-foreground hover:text-primary" /></a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {movement && (
        <MovementDialog
          locale={locale}
          options={{ ...options, accounts: props.balances.map((a) => ({ id: a.id, name: a.name, currency: a.currency })) }}
          canPaySalary={perms.paySalary}
          onClose={() => setMovement(false)}
          onSaved={(text) => {
            setMovement(false)
            setMessage({ text, tone: "ok" })
            refresh()
          }}
        />
      )}

      {editing && (
        <TransactionDialog
          t={t}
          locale={locale}
          options={options}
          row={editing.row}
          initial={editing.form}
          perms={perms}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form, post) => run(() => saveTransactionAction(editing.row?.status === "DRAFT" ? editing.row.id : null, form, post)).then((r) => r.ok && setEditing(null))}
          onDelete={() => editing.row && run(() => deleteDraftAction(editing.row!.id)).then((r) => r.ok && setEditing(null))}
          onReverse={(reason) => editing.row && run(() => reverseAction(editing.row!.id, reason)).then((r) => r.ok && setEditing(null))}
          onSettle={(input) => editing.row && run(() => settleAction(editing.row!.id, input)).then((r) => r.ok && setEditing(null))}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function Filters({ t, options, filters }: { t: TransactionTexts; options: Options; filters: Props["filters"] }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2 rounded-2xl border border-border bg-card/30 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input name="q" defaultValue={filters.q} placeholder={t.filters.search} className="h-8 w-64 pl-9" aria-label={t.filters.search} />
      </div>
      <Input type="date" name="from" defaultValue={filters.from} className="h-8 w-40" aria-label={t.filters.from} title={t.filters.from} />
      <Input type="date" name="to" defaultValue={filters.to} className="h-8 w-40" aria-label={t.filters.to} title={t.filters.to} />
      <Select name="type" defaultValue={filters.type} className="h-8 w-48" aria-label={t.filters.type}>
        <option value="">{t.filters.type}: {t.filters.all}</option>
        {TYPES.map((x) => <option key={x} value={x}>{t.types[x]}</option>)}
      </Select>
      <Select name="status" defaultValue={filters.status} className="h-8 w-40" aria-label={t.filters.status}>
        <option value="">{t.filters.status}: {t.filters.all}</option>
        {(["DRAFT", "POSTED", "REVERSED"] as const).map((x) => <option key={x} value={x}>{t.status[x]}</option>)}
      </Select>
      <Select name="account" defaultValue={filters.account} className="h-8 w-44" aria-label={t.filters.account}>
        <option value="">{t.filters.account}: {t.filters.all}</option>
        {options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
      <Select name="dept" defaultValue={filters.dept} className="h-8 w-44" aria-label={t.filters.department}>
        <option value="">{t.filters.department}: {t.filters.all}</option>
        {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </Select>
      <Select name="category" defaultValue={filters.category} className="h-8 w-52" aria-label={t.filters.category}>
        <option value="">{t.filters.category}: {t.filters.all}</option>
        {options.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <Button type="submit" variant="outline" size="sm">{t.filters.apply}</Button>
      <Link href="/transactions" className="px-2 text-xs text-muted-foreground hover:text-foreground">{t.filters.reset}</Link>
    </form>
  )
}

function Field({ label, children, span, hint }: { label: string; children: React.ReactNode; span?: boolean; hint?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-xs font-medium text-muted-foreground", span && "sm:col-span-2")}>
      {label}
      {children}
      {hint && <span className="text-[11px] font-normal text-muted-foreground/70">{hint}</span>}
    </label>
  )
}

function TransactionDialog(props: {
  t: TransactionTexts
  locale: Locale
  options: Options
  row: Row | null
  initial: TransactionForm
  perms: { create: boolean; post: boolean }
  busy: boolean
  onClose: () => void
  onSave: (form: TransactionForm, post: boolean) => void
  onDelete: () => void
  onReverse: (reason: string) => void
  onSettle: (input: { amount: string; financialAccountId: string; date: string }) => void
}) {
  const { t, options, row } = props
  const [form, setForm] = useState(props.initial)
  const [reason, setReason] = useState("")
  const [settle, setSettle] = useState({ amount: "", financialAccountId: options.accounts[0]?.id ?? "", date: today() })
  const set = (k: keyof TransactionForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const editable = !row || row.status === "DRAFT"
  const type = form.type as keyof TransactionTexts["types"]
  const settleable = ["REVENUE", "OPERATING_EXPENSE", "ASSET_PURCHASE"].includes(type)
  const unpaid = settleable && form.settlementStatus === "UNPAID"
  const revenueCats = options.categories.filter((c) => ["REVENUE", "OTHER_INCOME"].includes(c.kind))
  const expenseCats = options.categories.filter((c) => !["REVENUE", "OTHER_INCOME", "TAX"].includes(c.kind) && !["DELIVERY-PAYROLL", "OVERHEAD-PAYROLL"].includes(c.code))
  const categories =
    type === "REVENUE" ? revenueCats
      : type === "OPERATING_EXPENSE" ? expenseCats
        : type === "REFUND" ? (form.direction === "OUT" ? revenueCats : expenseCats)
          : type === "PAYROLL" ? options.categories.filter((c) => ["DELIVERY-PAYROLL", "OVERHEAD-PAYROLL"].includes(c.code))
            : type === "TAX_PAYMENT" ? options.categories.filter((c) => c.kind === "TAX")
              : []
  const ledger = (filter: (a: Options["ledgerAccounts"][number]) => boolean) => options.ledgerAccounts.filter(filter).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)
  const remaining = row ? Number(row.amount) - Number(row.settled) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={props.onClose}>
      <div role="dialog" aria-modal="true" aria-label={t.add} className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[#141015] p-6 shadow-2xl ring-1 ring-primary/25" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.16em] text-primary">{row ? `#${row.number} · ${t.status[row.status]}${row.journalEntryNumber ? ` · JE ${row.journalEntryNumber}` : ""}` : t.add}</p>
            <h2 className="font-display text-lg font-bold uppercase">{row ? row.description : t.types[type]}</h2>
          </div>
        </div>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
            props.onSave({ ...form, amount: normalizeNumber(form.amount) ?? form.amount, fee: normalizeNumber(form.fee) ?? form.fee, fxRate: normalizeNumber(form.fxRate) ?? form.fxRate }, submitter?.value === "post")
          }}
        >
          <fieldset disabled={!editable} className="contents">
            <Field label={t.col.type} span hint={t.typeHelp[type]}>
              <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, categoryId: "", settlementStatus: "PAID" }))}>
                {TYPES.map((x) => <option key={x} value={x}>{t.types[x]}</option>)}
              </Select>
            </Field>
            <Field label={t.col.date}><Input type="date" value={form.date} onChange={set("date")} required /></Field>
            <Field label={t.col.description}><Input value={form.description} onChange={set("description")} required maxLength={300} /></Field>
            <Field label={t.col.amount}><Input value={form.amount} onChange={set("amount")} inputMode="decimal" required /></Field>
            <Field label={t.col.currency}>
              <Select value={form.currency} onChange={set("currency")}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
            </Field>
            {form.currency !== "USD" && <Field label={t.col.fxRate} hint="1 unit = ? USD"><Input value={form.fxRate} onChange={set("fxRate")} inputMode="decimal" placeholder="auto" /></Field>}
            {settleable && (
              <Field label={t.col.payment}>
                <Select value={form.settlementStatus} onChange={set("settlementStatus")}>
                  <option value="PAID">{t.settlement.PAID}</option>
                  <option value="UNPAID">{t.unpaid}</option>
                </Select>
              </Field>
            )}
            {unpaid && <Field label={t.col.dueDate}><Input type="date" value={form.dueDate} onChange={set("dueDate")} /></Field>}
            {type !== "ADJUSTMENT" && !unpaid && (
              <Field label={type === "INTERNAL_TRANSFER" ? `${t.col.account} (→)` : t.col.account}>
                <Select value={form.financialAccountId} onChange={set("financialAccountId")} required>
                  <option value="">—</option>
                  {options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
                </Select>
              </Field>
            )}
            {type === "INTERNAL_TRANSFER" && (
              <Field label={t.col.toAccount}>
                <Select value={form.counterFinancialAccountId} onChange={set("counterFinancialAccountId")} required>
                  <option value="">—</option>
                  {options.accounts.filter((a) => a.id !== form.financialAccountId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
                </Select>
              </Field>
            )}
            {type === "REFUND" && (
              <Field label={t.col.direction} span>
                <Select value={form.direction} onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value, categoryId: "" }))} required>
                  <option value="">—</option>
                  <option value="OUT">{t.direction.OUT}</option>
                  <option value="IN">{t.direction.IN}</option>
                </Select>
              </Field>
            )}
            {categories.length > 0 && (
              <Field label={t.col.category}>
                <Select value={form.categoryId} onChange={set("categoryId")} required={["REVENUE", "OPERATING_EXPENSE", "REFUND"].includes(type)}>
                  <option value="">—</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            )}
            {(type === "LOAN_RECEIVED" || type === "LOAN_REPAYMENT") && (
              <Field label={t.col.loanAccount}>
                <Select value={type === "LOAN_RECEIVED" ? form.creditAccountId : form.debitAccountId} onChange={set(type === "LOAN_RECEIVED" ? "creditAccountId" : "debitAccountId")}>
                  <option value="">2650 Short-term loans</option>
                  {ledger((a) => a.subtype === "LONG_TERM_DEBT" || (a.subtype === "SHORT_TERM_DEBT" && a.code !== "2650"))}
                </Select>
              </Field>
            )}
            {(type === "ASSET_PURCHASE" || type === "INVESTMENT") && (
              <Field label={t.col.assetAccount}>
                <Select value={form.debitAccountId} onChange={set("debitAccountId")}>
                  <option value="">{type === "INVESTMENT" ? "1600 Investments" : "1500 Equipment"}</option>
                  {ledger((a) => ["FIXED_ASSET", "INTANGIBLE_ASSET", "OTHER_NON_CURRENT_ASSET"].includes(a.subtype))}
                </Select>
              </Field>
            )}
            {type === "ADJUSTMENT" && (
              <>
                <Field label={t.col.debitAccount}><Select value={form.debitAccountId} onChange={set("debitAccountId")} required><option value="">—</option>{ledger(() => true)}</Select></Field>
                <Field label={t.col.creditAccount}><Select value={form.creditAccountId} onChange={set("creditAccountId")} required><option value="">—</option>{ledger(() => true)}</Select></Field>
              </>
            )}
            {(type === "OWNER_CONTRIBUTION" || type === "OWNER_WITHDRAWAL") && (
              <Field label={t.col.owner}>
                <Select value={form.shareholderId} onChange={set("shareholderId")} required>
                  <option value="">—</option>
                  {options.shareholders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label={t.col.department}>
              <Select value={form.departmentId} onChange={set("departmentId")}><option value="">—</option>{options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
            </Field>
            {["REVENUE", "REFUND", "OPERATING_EXPENSE"].includes(type) && (
              <>
                <Field label={t.col.client}><Select value={form.clientId} onChange={set("clientId")}><option value="">—</option>{options.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
                <Field label={t.col.project}><Select value={form.projectId} onChange={set("projectId")}><option value="">—</option>{options.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
              </>
            )}
            <Field label={t.col.counterparty}><Input value={form.counterparty} onChange={set("counterparty")} maxLength={200} /></Field>
            {!unpaid && type !== "ADJUSTMENT" && <Field label={t.col.fee}><Input value={form.fee} onChange={set("fee")} inputMode="decimal" placeholder="0" /></Field>}
            <Field label={t.col.attachment} span><Input value={form.attachmentUrl} onChange={set("attachmentUrl")} placeholder="https://drive.google.com/…" type="url" /></Field>
            <Field label={t.col.comment} span><Textarea value={form.notes} onChange={set("notes")} maxLength={2000} /></Field>
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
            <div>{row?.status === "DRAFT" && props.perms.create && <Button type="button" variant="ghost" className="text-destructive" onClick={props.onDelete} disabled={props.busy}>{t.delete}</Button>}</div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={props.onClose}>×</Button>
              {editable && props.perms.create && <Button type="submit" value="draft" variant="outline" disabled={props.busy}>{t.saveDraft}</Button>}
              {editable && props.perms.post && <Button type="submit" value="post" disabled={props.busy}>{t.savePost}</Button>}
            </div>
          </div>
        </form>

        {row?.status === "POSTED" && props.perms.post && row.settlementStatus !== "PAID" && (
          <div className="mt-6 grid gap-3 border-t border-border pt-5 sm:grid-cols-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary sm:col-span-3">{t.settle} · {t.open}: {formatAmount(String(remaining), row.currency, props.locale)}</p>
            <Field label={t.settleAmount}><Input value={settle.amount} onChange={(e) => setSettle((s) => ({ ...s, amount: e.target.value }))} inputMode="decimal" /></Field>
            <Field label={t.col.account}><Select value={settle.financialAccountId} onChange={(e) => setSettle((s) => ({ ...s, financialAccountId: e.target.value }))}>{options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            <Field label={t.col.date}><Input type="date" value={settle.date} onChange={(e) => setSettle((s) => ({ ...s, date: e.target.value }))} /></Field>
            <div className="sm:col-span-3 flex justify-end"><Button type="button" disabled={props.busy} onClick={() => props.onSettle({ ...settle, amount: normalizeNumber(settle.amount) ?? "" })}>{t.settle}</Button></div>
          </div>
        )}
        {row?.status === "POSTED" && props.perms.post && (
          <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-border pt-5">
            <Field label={t.reverseReason}><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="w-72" /></Field>
            <Button type="button" variant="destructive" disabled={props.busy} onClick={() => window.confirm(fill(t.reverseConfirm, { n: row.number })) && props.onReverse(reason)}>{t.reverse}</Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

const BULK_COLUMNS = ["date", "type", "description", "amount", "currency", "account", "category", "department", "counterparty"] as const

function BulkEntry({ t, options, busy, onSave }: { t: TransactionTexts; options: Options; busy: boolean; onSave: (table: string[][]) => void }) {
  const blank = () => [today(), t.types.OPERATING_EXPENSE, "", "", "USD", options.accounts[0]?.name ?? "", "", "", ""]
  const [grid, setGrid] = useState<string[][]>([blank(), blank(), blank()])
  const labels = [t.col.date, t.col.type, t.col.description, t.col.amount, t.col.currency, t.col.account, t.col.category, t.col.department, t.col.counterparty]
  const lists: Record<string, string[]> = useMemo(
    () => ({ type: Object.values(t.types), currency: CURRENCIES, account: options.accounts.map((a) => a.name), category: options.categories.map((c) => c.name), department: options.departments.map((d) => d.name) }),
    [t, options],
  )
  const setCell = (r: number, c: number, v: string) => setGrid((g) => g.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)))
  const onPaste = (r: number, c: number) => (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain")
    if (!text.includes("\t") && !text.includes("\n")) return
    e.preventDefault()
    const pasted = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"))
    setGrid((g) => {
      const next = g.map((row) => [...row])
      pasted.forEach((line, dr) => {
        while (next.length <= r + dr) next.push(blank())
        line.forEach((v, dc) => c + dc < BULK_COLUMNS.length && (next[r + dr][c + dc] = v.trim()))
      })
      return next
    })
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-card/40 p-4">
      <p className="text-xs text-muted-foreground">{t.bulkHint}</p>
      {Object.entries(lists).map(([k, values]) => <datalist key={k} id={`bulk-${k}`}>{values.map((v) => <option key={v} value={v} />)}</datalist>)}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-[13px]">
          <thead className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground"><tr>{labels.map((l) => <th key={l} className="px-1 py-1 text-left font-medium">{l}</th>)}</tr></thead>
          <tbody>
            {grid.map((row, r) => (
              <tr key={r}>
                {row.map((v, c) => (
                  <td key={c} className="p-0.5">
                    <Input value={v} onChange={(e) => setCell(r, c, e.target.value)} onPaste={onPaste(r, c)} list={lists[BULK_COLUMNS[c]] ? `bulk-${BULK_COLUMNS[c]}` : undefined} className={cn("h-8 rounded-md px-2 text-[13px]", c === 3 && "text-right font-mono")} aria-label={`${labels[c]} ${r + 1}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setGrid((g) => [...g, blank()])}><Plus /> {t.addRow}</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => onSave(grid.filter((row) => row[2].trim() && row[3].trim()))}>{t.bulkSave}</Button>
      </div>
    </div>
  )
}

function Reconcile({ t, locale, baseCurrency, balances }: { t: TransactionTexts; locale: Locale; baseCurrency: string; balances: Props["balances"] }) {
  const [statement, setStatement] = useState<Record<string, string>>({})
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-card/40 p-4">
      <p className="text-xs text-muted-foreground">{t.reconcileHint}</p>
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          <tr><th className="py-1.5 text-left font-medium">{t.col.account}</th><th className="py-1.5 text-right font-medium">{t.ledgerBalance} ({baseCurrency})</th><th className="py-1.5 text-right font-medium">{t.statementBalance}</th><th className="py-1.5 text-right font-medium">{t.difference}</th></tr>
        </thead>
        <tbody>
          {balances.map((a) => {
            const s = normalizeNumber(statement[a.id] ?? "")
            const diff = s ? (Number(s) - Number(a.balance)).toFixed(2) : null
            return (
              <tr key={a.id} className="border-t border-border/50">
                <td className="py-1.5">{a.name} <span className="text-xs text-muted-foreground">{a.currency}</span></td>
                <td className="py-1.5 text-right font-mono">{formatAmount(a.balance, baseCurrency, locale)}</td>
                <td className="py-1.5 text-right"><Input value={statement[a.id] ?? ""} onChange={(e) => setStatement((x) => ({ ...x, [a.id]: e.target.value }))} inputMode="decimal" className="ml-auto h-8 w-36 text-right font-mono" aria-label={`${t.statementBalance} ${a.name}`} /></td>
                <td className={cn("py-1.5 text-right font-mono", diff && Number(diff) !== 0 ? "text-amber-300" : "text-emerald-300/80")}>{diff === null ? "—" : formatAmount(diff, baseCurrency, locale)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
