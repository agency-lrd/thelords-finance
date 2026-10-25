"use client"

import { Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { MovementDialog, type MovementOptions } from "@/components/finance/movement-dialog"
import { Button } from "@/components/ui/button"
import type { ownerMovements } from "@/lib/data/cash-register"
import { formatAmount, formatDate, type Locale } from "@/lib/i18n/format"
import { KIND_LABELS, KINDS, OWNER_KINDS } from "@/lib/transactions/kinds"

type Row = Awaited<ReturnType<typeof ownerMovements>>[number]

const T = {
  ru: {
    title: "Движения собственников и инвесторов",
    hint: "Взносы, выплаты, займы и возвраты капитала. Это те же записи, что в «Транзакциях» и Cash Flow — одна запись, несколько представлений. Они не влияют на операционную прибыль и не считаются зарплатой или расходом.",
    add: "Записать движение",
    date: "Дата",
    who: "Кто",
    kind: "Тип",
    amount: "Сумма",
    account: "Счёт",
    status: "Статус",
    notes: "Комментарий",
    empty: "Пока нет движений.",
    statuses: { DRAFT: "Черновик", POSTED: "Проведено", REVERSED: "Сторнировано" } as Record<string, string>,
    contributed: "Получено от собственников и инвесторов",
    paidOut: "Выплачено собственникам и инвесторам",
  },
  en: {
    title: "Owner and investor movements",
    hint: "Contributions, payouts, loans and capital returns. The same records as in Transactions and Cash Flow: one record, several views. They never affect operating profit and are never salary or expenses.",
    add: "Record movement",
    date: "Date",
    who: "Who",
    kind: "Type",
    amount: "Amount",
    account: "Account",
    status: "Status",
    notes: "Comment",
    empty: "No movements yet.",
    statuses: { DRAFT: "Draft", POSTED: "Posted", REVERSED: "Reversed" } as Record<string, string>,
    contributed: "Received from owners and investors",
    paidOut: "Paid to owners and investors",
  },
}

export function OwnerMovements(props: { locale: Locale; currency: string; rows: Row[]; options: MovementOptions; canCreate: boolean }) {
  const t = T[props.locale]
  const labels = KIND_LABELS[props.locale]
  const router = useRouter()
  const [, startRefresh] = useTransition()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const posted = props.rows.filter((r) => r.status === "POSTED")
  const sum = (dir: "IN" | "OUT") => posted.filter((r) => KINDS[r.kind].direction === dir).reduce((a, r) => a + Number(r.baseAmount), 0)

  return (
    <section className="mt-8 flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="font-display text-xl font-black uppercase">{t.title}</h2>
          <p className="text-sm text-muted-foreground">{t.hint}</p>
        </div>
        {props.canCreate && props.options.accounts.length > 0 && (
          <Button size="sm" onClick={() => setOpen(true)}><Plus /> {t.add}</Button>
        )}
      </div>
      {message && <p role="status" className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm">{message}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-border p-3"><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t.contributed}</p><p className="font-mono text-lg font-semibold">{formatAmount(String(sum("IN")), props.currency, props.locale)}</p></div>
        <div className="rounded-xl border border-border p-3"><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t.paidOut}</p><p className="font-mono text-lg font-semibold">{formatAmount(String(sum("OUT")), props.currency, props.locale)}</p></div>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-card/50 ring-1 ring-foreground/10">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            <tr>{[t.date, t.who, t.kind, t.amount, t.account, t.status, t.notes].map((h, i) => <th key={h} className={cn("px-3 py-2.5 text-left font-medium", i === 3 && "text-right")}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {props.rows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">{t.empty}</td></tr>}
            {props.rows.map((r) => (
              <tr key={r.id} className={cn("border-t border-border/50", r.status === "REVERSED" && "text-muted-foreground line-through")}>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.date, props.locale)}</td>
                <td className="px-3 py-2">{r.shareholder ?? "—"}</td>
                <td className="px-3 py-2">{labels[r.kind]}</td>
                <td className={cn("px-3 py-2 text-right font-mono", KINDS[r.kind].direction === "IN" ? "text-emerald-300" : "text-amber-200")}>{KINDS[r.kind].direction === "IN" ? "+" : "−"}{formatAmount(r.amount, r.currency, props.locale)}</td>
                <td className="px-3 py-2">{r.account ?? "—"}</td>
                <td className="px-3 py-2">{t.statuses[r.status] ?? r.status}</td>
                <td className="max-w-64 truncate px-3 py-2 text-muted-foreground">{r.notes ?? r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <MovementDialog
          locale={props.locale}
          options={props.options}
          kinds={OWNER_KINDS}
          onClose={() => setOpen(false)}
          onSaved={(text) => {
            setOpen(false)
            setMessage(text)
            startRefresh(() => router.refresh())
          }}
        />
      )}
    </section>
  )
}
