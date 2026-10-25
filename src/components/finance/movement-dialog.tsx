"use client"

import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Loader2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { cn } from "cn"

import { Panel } from "@/app/(app)/payroll/sheet-admin"
import { paySalaryAction, payslipsToPayAction, recordMovementAction, type MovementForm } from "@/app/(app)/transactions/register-actions"
import { Button } from "@/components/ui/button"
import { Input, Select, Textarea } from "@/components/ui/form-controls"
import { formatAmount, type Locale } from "@/lib/i18n/format"
import { KIND_KEYS, KIND_LABELS, KINDS, type Direction, type Kind } from "@/lib/transactions/kinds"

export type MovementOptions = {
  accounts: { id: string; name: string; currency: string }[]
  departments: { id: string; name: string }[]
  clients: { id: string; name: string; categoryId: string | null }[]
  clientCategories: { id: string; name: string }[]
  teams: { id: string; name: string; departmentId: string }[]
  projects: { id: string; name: string }[]
  shareholders: { id: string; name: string }[]
  categories: { id: string; name: string; kind: string; code: string }[]
}

const T = {
  ru: {
    title: "Записать движение денег",
    in: "Поступление",
    out: "Выплата",
    transfer: "Перевод",
    kind: "Что это",
    date: "Дата",
    amount: "Сумма",
    currency: "Валюта",
    rate: "Курс к USD",
    fee: "Комиссия (необязательно)",
    account: "Счёт / кошелёк",
    toAccount: "На счёт",
    department: "Отдел",
    client: "Рекламодатель",
    clientHint: "Выберите из списка или введите новое имя — клиент добавится в справочник.",
    clientCategory: "Категория клиента",
    project: "Проект",
    team: "Команда",
    owner: "Собственник / инвестор",
    category: "Категория",
    autoCategory: "автоматически по отделу",
    counterparty: "Получатель / контрагент",
    description: "Описание",
    notes: "Комментарий",
    none: "—",
    save: "Записать",
    cancel: "Отмена",
    payslip: "Сотрудник и месяц (утверждённая ведомость)",
    noPayslips: "Нет утверждённых расчётов с остатком к выплате. Утвердите месяц в финансовом листе.",
    outstanding: "Осталось выплатить",
    saved: "Записано — движение попало в Транзакции и Cash Flow.",
    draft: "Сохранено как черновик: проведение требует права journal:post.",
    pnlNo: "Не влияет на прибыль (P&L): это движение капитала, займа или транзита.",
    pnlYes: "Влияет на P&L и Cash Flow.",
    salaryNote: "Выплата закрывает утверждённую зарплату: попадает в Cash Flow, а расход в P&L уже учтён при утверждении месяца — двойного расхода нет.",
  },
  en: {
    title: "Record a money movement",
    in: "Money in",
    out: "Money out",
    transfer: "Transfer",
    kind: "What it is",
    date: "Date",
    amount: "Amount",
    currency: "Currency",
    rate: "Rate to USD",
    fee: "Fee (optional)",
    account: "Account / wallet",
    toAccount: "To account",
    department: "Department",
    client: "Advertiser",
    clientHint: "Pick from the list or type a new name: the client is added to the directory.",
    clientCategory: "Client category",
    project: "Project",
    team: "Team",
    owner: "Owner / investor",
    category: "Category",
    autoCategory: "automatic by department",
    counterparty: "Payee / counterparty",
    description: "Description",
    notes: "Comment",
    none: "—",
    save: "Record",
    cancel: "Cancel",
    payslip: "Employee and month (approved payroll)",
    noPayslips: "No approved payslips with an amount to pay. Approve the month on the financial sheet.",
    outstanding: "Left to pay",
    saved: "Recorded: the movement is in Transactions and Cash Flow.",
    draft: "Saved as a draft: posting needs the journal:post permission.",
    pnlNo: "Does not affect profit (P&L): a capital, loan or pass-through movement.",
    pnlYes: "Affects P&L and Cash Flow.",
    salaryNote: "Pays approved salary: goes to Cash Flow; the P&L expense was recorded when the month was approved, so it is never counted twice.",
  },
}

type Payslip = { payrollItemId: string; name: string; month: string; outstanding: string; currency: string }

const today = () => new Date().toISOString().slice(0, 10)

export function MovementDialog(props: {
  locale: Locale
  options: MovementOptions
  /** Restrict to these kinds (e.g. owner/investor kinds on the Owners page). */
  kinds?: Kind[]
  initialKind?: Kind
  initial?: Partial<MovementForm>
  canPaySalary?: boolean
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const t = T[props.locale]
  const labels = KIND_LABELS[props.locale]
  const allowed = useMemo(() => (props.kinds ?? KIND_KEYS).filter((k) => k !== "SALARY" || props.canPaySalary), [props.kinds, props.canPaySalary])
  const first = props.initialKind && allowed.includes(props.initialKind) ? props.initialKind : allowed[0]
  const [direction, setDirection] = useState<Direction>(KINDS[first].direction)
  const [form, setForm] = useState<MovementForm>({
    kind: first, date: today(), amount: "", currency: props.options.accounts[0]?.currency === "USDT" ? "USDT" : "USD", fxRate: "", fee: "",
    financialAccountId: props.options.accounts[0]?.id ?? "", counterFinancialAccountId: "", departmentId: "", clientId: "", clientName: "", clientCategoryId: "",
    projectId: "", teamId: "", shareholderId: "", categoryId: "", counterparty: "", description: "", notes: "", ...props.initial,
  })
  const [payslips, setPayslips] = useState<Payslip[] | null>(null)
  const [payslipId, setPayslipId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<MovementForm>) => setForm((f) => ({ ...f, ...patch }))
  const kind = form.kind as Kind
  const spec = KINDS[kind]
  const directions = (["IN", "OUT", "TRANSFER"] as Direction[]).filter((d) => allowed.some((k) => KINDS[k].direction === d))
  const kinds = allowed.filter((k) => KINDS[k].direction === direction)

  useEffect(() => {
    if (kind !== "SALARY" || payslips) return
    let alive = true
    payslipsToPayAction().then((r) => {
      if (!alive) return
      if (r.ok) setPayslips(r.payslips)
      else setError(r.message)
    })
    return () => {
      alive = false
    }
  }, [kind, payslips])

  const categories = props.options.categories.filter((c) =>
    spec.needs.category === "revenue" ? c.kind === "REVENUE" : spec.needs.category === "otherIncome" ? c.kind === "OTHER_INCOME" : spec.needs.category === "expense" ? ["COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_EXPENSE"].includes(c.kind) && !["DELIVERY-PAYROLL", "OVERHEAD-PAYROLL"].includes(c.code) : false,
  )
  const teams = props.options.teams.filter((x) => !form.departmentId || x.departmentId === form.departmentId)
  const slip = payslips?.find((p) => p.payrollItemId === payslipId) ?? null

  async function save() {
    setBusy(true)
    setError(null)
    const r =
      kind === "SALARY"
        ? await paySalaryAction({ payrollItemId: payslipId, amount: form.amount, currency: form.currency, fxRate: form.fxRate, fee: form.fee, financialAccountId: form.financialAccountId, date: form.date, reference: form.notes })
        : await recordMovementAction(form)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    props.onSaved("posted" in r && r.posted === false ? t.draft : t.saved)
  }

  const field = (label: string, child: React.ReactNode, hint?: string) => (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {label}
      {child}
      {hint && <span className="text-[10px]">{hint}</span>}
    </label>
  )

  return (
    <Panel title={t.title} onClose={props.onClose} wide>
      {directions.length > 1 && (
        <div className="flex gap-2" role="tablist">
          {directions.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={direction === d}
              onClick={() => {
                setDirection(d)
                set({ kind: allowed.find((k) => KINDS[k].direction === d)! })
              }}
              className={cn("flex flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold", direction === d ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
            >
              {d === "IN" ? <ArrowDownLeft className="size-4" /> : d === "OUT" ? <ArrowUpRight className="size-4" /> : <ArrowRightLeft className="size-4" />}
              {d === "IN" ? t.in : d === "OUT" ? t.out : t.transfer}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {field(t.kind, <Select value={kind} onChange={(e) => set({ kind: e.target.value })} className="h-9">{kinds.map((k) => <option key={k} value={k}>{labels[k]}</option>)}</Select>)}
        {field(t.date, <Input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} className="h-9" />)}

        {kind === "SALARY" && (
          <div className="sm:col-span-2">
            {field(
              t.payslip,
              payslips === null ? <Loader2 className="size-4 animate-spin" /> : payslips.length === 0 ? <span className="text-amber-300">{t.noPayslips}</span> : (
                <Select
                  value={payslipId}
                  onChange={(e) => {
                    const p = payslips.find((x) => x.payrollItemId === e.target.value)
                    setPayslipId(e.target.value)
                    if (p) set({ amount: p.outstanding, currency: p.currency })
                  }}
                  className="h-9"
                >
                  <option value="">—</option>
                  {payslips.map((p) => <option key={p.payrollItemId} value={p.payrollItemId}>{p.name} · {p.month} · {t.outstanding}: {formatAmount(p.outstanding, p.currency, props.locale)}</option>)}
                </Select>
              ),
            )}
          </div>
        )}

        {field(t.amount, <Input inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value })} className="h-9 font-mono" placeholder={slip ? slip.outstanding : "0.00"} />)}
        {field(t.currency, <Select value={form.currency} onChange={(e) => set({ currency: e.target.value })} className="h-9">{["USD", "USDT", "EUR", "GBP"].map((c) => <option key={c}>{c}</option>)}</Select>)}
        {form.currency !== "USD" && field(t.rate, <Input inputMode="decimal" value={form.fxRate} onChange={(e) => set({ fxRate: e.target.value })} className="h-9 font-mono" placeholder={form.currency === "USDT" ? "1" : ""} />)}
        {field(t.account, <Select value={form.financialAccountId} onChange={(e) => set({ financialAccountId: e.target.value })} className="h-9">{props.options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</Select>)}
        {spec.needs.counterAccount && field(t.toAccount, <Select value={form.counterFinancialAccountId} onChange={(e) => set({ counterFinancialAccountId: e.target.value })} className="h-9"><option value="">—</option>{props.options.accounts.filter((a) => a.id !== form.financialAccountId).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</Select>)}

        {spec.needs.client && (
          <>
            {field(
              t.client,
              <>
                <Input
                  list="movement-clients"
                  value={form.clientName}
                  onChange={(e) => {
                    const match = props.options.clients.find((c) => c.name.toLowerCase() === e.target.value.trim().toLowerCase())
                    set({ clientName: e.target.value, clientId: match?.id ?? "", clientCategoryId: match?.categoryId ?? form.clientCategoryId })
                  }}
                  className="h-9"
                />
                <datalist id="movement-clients">{props.options.clients.map((c) => <option key={c.id} value={c.name} />)}</datalist>
              </>,
              t.clientHint,
            )}
            {field(t.clientCategory, <Select value={form.clientCategoryId} onChange={(e) => set({ clientCategoryId: e.target.value })} className="h-9"><option value="">—</option>{props.options.clientCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>)}
          </>
        )}

        {spec.group !== "owners" && spec.group !== "investors" && spec.group !== "transfers" && kind !== "SALARY" && field(t.department, <Select value={form.departmentId} onChange={(e) => set({ departmentId: e.target.value, teamId: "" })} className="h-9"><option value="">—</option>{props.options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>)}
        {spec.needs.client && props.options.projects.length > 0 && field(t.project, <Select value={form.projectId} onChange={(e) => set({ projectId: e.target.value })} className="h-9"><option value="">—</option>{props.options.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>)}
        {teams.length > 0 && spec.group !== "owners" && spec.group !== "investors" && spec.group !== "transfers" && kind !== "SALARY" && field(t.team, <Select value={form.teamId} onChange={(e) => set({ teamId: e.target.value })} className="h-9"><option value="">—</option>{teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>)}
        {spec.needs.shareholder && field(t.owner, <Select value={form.shareholderId} onChange={(e) => set({ shareholderId: e.target.value })} className="h-9"><option value="">—</option>{props.options.shareholders.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>)}
        {spec.needs.category && field(t.category, <Select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className="h-9"><option value="">{kind === "CLIENT_PAYMENT" || spec.categoryCode ? t.autoCategory : "—"}</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>)}
        {["CONTRACTOR", "SUPPLIER", "OPERATING", "OTHER_OUT", "OTHER_INCOME", "LOAN_RECEIVED", "LOAN_REPAYMENT", "TAX", "REFUND_IN"].includes(kind) && field(t.counterparty, <Input value={form.counterparty} onChange={(e) => set({ counterparty: e.target.value })} className="h-9" />)}
        {kind !== "SALARY" && field(t.fee, <Input inputMode="decimal" value={form.fee} onChange={(e) => set({ fee: e.target.value })} className="h-9 font-mono" />)}
        {kind !== "SALARY" && <div className="sm:col-span-2">{field(t.description, <Input value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} className="h-9" />)}</div>}
        <div className="sm:col-span-2">{field(t.notes, <Textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} maxLength={2000} />)}</div>
      </div>
      <p className="text-[11px] text-muted-foreground">{kind === "SALARY" ? t.salaryNote : spec.pnl ? t.pnlYes : t.pnlNo}</p>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onClose}>{t.cancel}</Button>
        <Button disabled={busy || !form.amount || !form.financialAccountId || (kind === "SALARY" && !payslipId)} onClick={save}>
          {busy && <Loader2 className="animate-spin" />} {t.save}
        </Button>
      </div>
    </Panel>
  )
}
