"use client"

import Decimal from "decimal.js"
import { Check, Pencil, Plus, X } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { InfoTip } from "@/components/reports/info"
import { Button } from "@/components/ui/button"
import { Input, Select, Textarea } from "@/components/ui/form-controls"
import type { listDistributions, listOwners } from "@/lib/data/owners"
import { formatAmount, formatDate, normalizeNumber, type Locale } from "@/lib/i18n/format"
import { allocateDistribution } from "@/lib/reports/statements"

import { approveDistributionAction, cancelDistributionAction, createDistributionAction, payAllocationAction, saveOwnerAction } from "./actions"

type Owner = Awaited<ReturnType<typeof listOwners>>[number]
type Distribution = Awaited<ReturnType<typeof listDistributions>>[number]

const T = {
  ru: {
    title: "Собственники и инвесторы",
    description: "Доли владения и участия в прибыли (с датой начала), капитал, распределения и выплаты. Распределения — это капитал, не расход: они не уменьшают EBITDA.",
    owners: "Собственники",
    name: "Имя",
    ownership: "Доля владения",
    profit: "Участие в прибыли",
    since: "С даты",
    contributed: "Внесённый капитал",
    withdrawn: "Изъято",
    allocated: "Распределено",
    paid: "Выплачено",
    outstanding: "К выплате",
    total: "Итого",
    add: "Добавить собственника",
    edit: "Изменить",
    save: "Сохранить",
    cancel: "Отмена",
    type: "Тип",
    individual: "Физлицо",
    company: "Компания",
    email: "Email",
    shareHint: "Новая доля действует с указанной даты; прошлые распределения не меняются.",
    initial: "Начальная структура 25 / 25 / 50",
    reference: "Справочно (не сумма к распределению)",
    netProfitYtd: "Чистая прибыль с начала года",
    retained: "Нераспределённая прибыль (баланс)",
    cash: "Остаток денег",
    distributedYtd: "Утверждено распределений в этом году",
    newDistribution: "Новое распределение",
    distributable: "Распределяемая прибыль (решение собственников)",
    payout: "Выплатить сейчас, %",
    date: "Дата решения",
    notes: "Комментарий",
    preview: "Предпросмотр",
    reinvested: "Реинвестируется",
    create: "Создать черновик",
    distributions: "Распределения",
    approve: "Утвердить",
    cancelDraft: "Отменить",
    pay: "Отметить выплату",
    account: "Со счёта",
    paymentRef: "Референс / хэш",
    status: { DRAFT: "Черновик", APPROVED: "Утверждено", PAID: "Выплачено", CANCELLED: "Отменено" },
    basis: "База",
    none: "Пока нет",
    noShares: "Сначала задайте доли собственников.",
    sumWarning: "Сумма долей участия в прибыли: {v}%.",
  },
  en: {
    title: "Owners and investors",
    description: "Ownership and profit participation (effective-dated), capital, distributions and payments. Distributions are equity, not an expense: they do not reduce EBITDA.",
    owners: "Owners",
    name: "Name",
    ownership: "Ownership",
    profit: "Profit participation",
    since: "Since",
    contributed: "Capital contributed",
    withdrawn: "Withdrawn",
    allocated: "Allocated",
    paid: "Paid",
    outstanding: "Outstanding",
    total: "Total",
    add: "Add owner",
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    type: "Type",
    individual: "Individual",
    company: "Company",
    email: "Email",
    shareHint: "The new share applies from the date; past distributions are unchanged.",
    initial: "Initial structure 25 / 25 / 50",
    reference: "For reference (not the amount to distribute)",
    netProfitYtd: "Net profit year to date",
    retained: "Retained earnings (balance sheet)",
    cash: "Cash balance",
    distributedYtd: "Distributions approved this year",
    newDistribution: "New distribution",
    distributable: "Distributable profit (owners' decision)",
    payout: "Pay out now, %",
    date: "Decision date",
    notes: "Comment",
    preview: "Preview",
    reinvested: "Reinvested",
    create: "Create draft",
    distributions: "Distributions",
    approve: "Approve",
    cancelDraft: "Cancel",
    pay: "Mark paid",
    account: "From account",
    paymentRef: "Reference / hash",
    status: { DRAFT: "Draft", APPROVED: "Approved", PAID: "Paid", CANCELLED: "Cancelled" },
    basis: "Basis",
    none: "None yet",
    noShares: "Set the owners' shares first.",
    sumWarning: "Profit participation adds up to {v}%.",
  },
}

const today = () => new Date().toISOString().slice(0, 10)
const pct = (v: string | null) => (v === null ? "—" : `${new Decimal(v).mul(100).toDecimalPlaces(2).toString()}%`)

export function OwnersView(props: {
  locale: Locale
  currency: string
  owners: Owner[]
  distributions: Distribution[]
  reference: { netProfitYtd: string; retained: string; cash: string; distributedYtd: string }
  accounts: { id: string; name: string }[]
  perms: { manage: boolean; distribute: boolean; approve: boolean }
}) {
  const { locale, currency, owners } = props
  const t = T[locale]
  const router = useRouter()
  const [, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ id: string | null; name: string; type: string; email: string; ownership: string; profit: string; from: string } | null>(null)
  const [dist, setDist] = useState({ date: today(), basis: "", payout: "100", notes: "" })
  const [pay, setPay] = useState<{ id: string; accountId: string; date: string; reference: string } | null>(null)
  const money = (v: string | null) => (v === null ? "—" : formatAmount(v, currency, locale))
  const active = owners.filter((o) => o.ownershipShare)
  const profitSum = active.reduce((a, o) => a.add(o.profitShare ?? 0), new Decimal(0))

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(r.message ?? "Error")
    else start(() => router.refresh())
    return r.ok
  }

  let preview: ReturnType<typeof allocateDistribution> | null = null
  try {
    const basis = normalizeNumber(dist.basis)
    const payout = normalizeNumber(dist.payout)
    if (basis && payout && active.length) preview = allocateDistribution(new Decimal(basis).mul(payout).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN), active.map((o) => ({ id: o.id, share: o.profitShare! })))
  } catch {
    preview = null
  }

  const totals = owners.reduce((a, o) => ({ contributed: a.contributed.add(o.capitalContributed), allocated: a.allocated.add(o.allocated), paid: a.paid.add(o.paid), outstanding: a.outstanding.add(o.outstanding) }), { contributed: new Decimal(0), allocated: new Decimal(0), paid: new Decimal(0), outstanding: new Decimal(0) })

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{t.title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
      </div>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">{error}</p>}

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-black uppercase italic">{t.owners}</h2>
          {props.perms.manage && (
            <div className="flex gap-2">
              {owners.length === 0 && (
                <Button size="sm" variant="outline" onClick={() => setEditing({ id: null, name: "", type: "INDIVIDUAL", email: "", ownership: "25", profit: "", from: today() })}>{t.initial}</Button>
              )}
              <Button size="sm" onClick={() => setEditing({ id: null, name: "", type: "INDIVIDUAL", email: "", ownership: "", profit: "", from: today() })}><Plus /> {t.add}</Button>
            </div>
          )}
        </div>
        {active.length > 0 && !profitSum.eq(1) && <p className="text-xs text-amber-300">{t.sumWarning.replace("{v}", profitSum.mul(100).toDecimalPlaces(2).toString())}</p>}
        <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              <tr>{[t.name, t.ownership, t.profit, t.since, t.contributed, t.withdrawn, t.allocated, t.paid, t.outstanding, ""].map((h, i) => <th key={i} className={cn("px-3 py-2.5 font-medium", i >= 1 && i <= 8 && i !== 3 ? "text-right" : "text-left")}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {owners.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">{t.none}</td></tr>}
              {owners.map((o) => (
                <tr key={o.id} className={cn("border-t border-border/50", o.archived && "text-muted-foreground")}>
                  <td className="px-3 py-2 font-medium">{o.name}</td>
                  <td className="px-3 py-2 text-right font-mono">{pct(o.ownershipShare)}</td>
                  <td className="px-3 py-2 text-right font-mono">{pct(o.profitShare)}</td>
                  <td className="px-3 py-2">{o.stakeFrom ? formatDate(o.stakeFrom, locale) : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(o.capitalContributed)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(o.withdrawn)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(o.allocated)}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(o.paid)}</td>
                  <td className={cn("px-3 py-2 text-right font-mono", o.outstanding !== "0" && "text-amber-300")}>{money(o.outstanding)}</td>
                  <td className="px-3 py-2 text-right">
                    {props.perms.manage && (
                      <button type="button" aria-label={t.edit} className="text-muted-foreground hover:text-primary" onClick={() => setEditing({ id: o.id, name: o.name, type: o.type, email: o.email ?? "", ownership: o.ownershipShare ? new Decimal(o.ownershipShare).mul(100).toString() : "", profit: o.profitShare && o.profitShare !== o.ownershipShare ? new Decimal(o.profitShare).mul(100).toString() : "", from: today() })}>
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {owners.length > 0 && (
              <tfoot>
                <tr className="border-t border-primary/40 bg-[#3a0d29] font-semibold text-white">
                  <td className="px-3 py-2">{t.total}</td>
                  <td className="px-3 py-2 text-right font-mono">{pct(active.reduce((a, o) => a.add(o.ownershipShare ?? 0), new Decimal(0)).toString())}</td>
                  <td className="px-3 py-2 text-right font-mono">{pct(profitSum.toString())}</td>
                  <td />
                  <td className="px-3 py-2 text-right font-mono">{money(totals.contributed.toString())}</td>
                  <td />
                  <td className="px-3 py-2 text-right font-mono">{money(totals.allocated.toString())}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(totals.paid.toString())}</td>
                  <td className="px-3 py-2 text-right font-mono">{money(totals.outstanding.toString())}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {editing && (
          <form
            className="grid gap-3 rounded-2xl border border-primary/30 bg-card/40 p-4 sm:grid-cols-3 lg:grid-cols-7"
            onSubmit={async (e) => {
              e.preventDefault()
              if (await run(() => saveOwnerAction(editing))) setEditing(null)
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground lg:col-span-2">{t.name}<Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required maxLength={160} /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.type}<Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}><option value="INDIVIDUAL">{t.individual}</option><option value="COMPANY">{t.company}</option></Select></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.ownership}, %<Input value={editing.ownership} onChange={(e) => setEditing({ ...editing, ownership: e.target.value })} inputMode="decimal" placeholder="25" /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.profit}, %<Input value={editing.profit} onChange={(e) => setEditing({ ...editing, profit: e.target.value })} inputMode="decimal" placeholder="= ownership" /></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.since}<Input type="date" value={editing.from} onChange={(e) => setEditing({ ...editing, from: e.target.value })} required /></label>
            <div className="flex items-end gap-2">
              <Button type="submit" size="sm" disabled={busy}><Check /> {t.save}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label={t.cancel}><X /></Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3 lg:col-span-7">{t.shareHint}</p>
          </form>
        )}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_1.3fr]">
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border bg-card/60 p-5">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t.reference}</p>
            {[[t.netProfitYtd, props.reference.netProfitYtd], [t.retained, props.reference.retained], [t.cash, props.reference.cash], [t.distributedYtd, props.reference.distributedYtd]].map(([label, value]) => (
              <div key={label} className="flex justify-between border-t border-border/40 py-2 text-sm first:border-0"><span className="text-muted-foreground">{label}</span><span className="font-mono">{money(value)}</span></div>
            ))}
          </div>
          {props.perms.distribute && (
            <form
              className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-card/40 p-5"
              onSubmit={async (e) => {
                e.preventDefault()
                if (await run(() => createDistributionAction(dist))) setDist({ date: today(), basis: "", payout: "100", notes: "" })
              }}
            >
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.newDistribution}</p>
              {active.length === 0 && <p className="text-sm text-muted-foreground">{t.noShares}</p>}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>{t.distributable} <InfoTip text={locale === "ru" ? "Сумму определяют собственники. Чистая прибыль показана справочно и не распределяется автоматически." : "The owners decide this amount. Net profit is shown for reference and is never distributed automatically."} /></span>
                <Input value={dist.basis} onChange={(e) => setDist({ ...dist, basis: e.target.value })} inputMode="decimal" required />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.payout}<Input value={dist.payout} onChange={(e) => setDist({ ...dist, payout: e.target.value })} inputMode="decimal" /></label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.date}<Input type="date" value={dist.date} onChange={(e) => setDist({ ...dist, date: e.target.value })} required /></label>
              </div>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t.notes}<Textarea value={dist.notes} onChange={(e) => setDist({ ...dist, notes: e.target.value })} maxLength={500} /></label>
              {preview && (
                <div className="rounded-xl bg-white/[0.03] p-3 text-sm">
                  <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t.preview}</p>
                  {preview.allocations.map((a) => (
                    <div key={a.id} className="flex justify-between py-0.5"><span>{owners.find((o) => o.id === a.id)?.name} · {pct(a.share)}</span><span className="font-mono">{money(a.amount)}</span></div>
                  ))}
                  <div className="mt-1 flex justify-between border-t border-border/50 pt-1 text-muted-foreground"><span>{t.reinvested}</span><span className="font-mono">{money(new Decimal(normalizeNumber(dist.basis) || 0).sub(preview.allocated).toString())}</span></div>
                </div>
              )}
              <Button type="submit" disabled={busy || active.length === 0}>{t.create}</Button>
            </form>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="font-display text-xl font-black uppercase italic">{t.distributions}</h2>
          {props.distributions.length === 0 && <p className="text-sm text-muted-foreground">{t.none}</p>}
          {props.distributions.map((d) => (
            <div key={d.id} className={cn("rounded-2xl border bg-card/60 p-5", d.status === "CANCELLED" ? "border-border opacity-60" : "border-border")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-xl font-black">{money(d.totalAmount)}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(d.declaredDate, locale)} · {t.basis} {money(d.basisAmount)} · {t.reinvested} {money(d.retained)}{d.notes ? ` · ${d.notes}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px]", d.status === "PAID" ? "border-emerald-500/40 text-emerald-300" : d.status === "APPROVED" ? "border-primary/50 text-primary" : "border-border text-muted-foreground")}>{t.status[d.status]}</span>
                  {d.status === "DRAFT" && props.perms.approve && <Button size="xs" disabled={busy} onClick={() => run(() => approveDistributionAction(d.id))}>{t.approve}</Button>}
                  {d.status === "DRAFT" && props.perms.distribute && <Button size="xs" variant="ghost" disabled={busy} onClick={() => run(() => cancelDistributionAction(d.id))}>{t.cancelDraft}</Button>}
                </div>
              </div>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {d.allocations.map((a) => (
                    <tr key={a.id} className="border-t border-border/40">
                      <td className="py-1.5">{a.name} <span className="text-xs text-muted-foreground">{pct(a.share)}</span></td>
                      <td className="py-1.5 text-right font-mono">{money(a.amount)}</td>
                      <td className="py-1.5 pl-3 text-right text-xs">
                        {a.paidAt ? (
                          <span className="text-emerald-300/90">{t.paid} {formatDate(a.paidAt, locale)}{a.account ? ` · ${a.account}` : ""}</span>
                        ) : d.status === "APPROVED" && props.perms.distribute ? (
                          pay?.id === a.id ? (
                            <span className="flex flex-wrap items-center justify-end gap-1.5">
                              <Select value={pay.accountId} onChange={(e) => setPay({ ...pay, accountId: e.target.value })} className="h-7 w-36 text-xs" aria-label={t.account}>
                                {props.accounts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                              </Select>
                              <Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} className="h-7 w-36 text-xs" aria-label={t.date} />
                              <Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} placeholder={t.paymentRef} className="h-7 w-32 text-xs" />
                              <Button size="xs" disabled={busy || !pay.accountId} onClick={async () => (await run(() => payAllocationAction(a.id, pay))) && setPay(null)}>{t.save}</Button>
                            </span>
                          ) : (
                            <Button size="xs" variant="outline" onClick={() => setPay({ id: a.id, accountId: props.accounts[0]?.id ?? "", date: today(), reference: "" })}>{t.pay}</Button>
                          )
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
