"use client"

import { Archive, ArchiveRestore, Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/form-controls"
import type { listCategoryTree } from "@/lib/data/categories"
import type { Locale } from "@/lib/i18n/format"

import { createCategoryAction, updateCategoryAction } from "./actions"

type Data = Awaited<ReturnType<typeof listCategoryTree>>
const KINDS = ["REVENUE", "OTHER_INCOME", "COST_OF_SALES", "OPERATING_EXPENSE", "DEPRECIATION", "AMORTIZATION", "INTEREST", "TAX", "OTHER_EXPENSE"] as const
const SUBTYPE: Record<(typeof KINDS)[number], string> = { REVENUE: "OPERATING_REVENUE", OTHER_INCOME: "OTHER_INCOME", COST_OF_SALES: "COST_OF_SALES", OPERATING_EXPENSE: "OPERATING_EXPENSE", DEPRECIATION: "DEPRECIATION", AMORTIZATION: "AMORTIZATION", INTEREST: "INTEREST_EXPENSE", TAX: "INCOME_TAX", OTHER_EXPENSE: "OTHER_EXPENSE" }

const T = {
  ru: {
    title: "Категории",
    description: "Категории доходов и расходов, подкатегории и строки P&L, в которые они попадают. Новые категории сразу доступны во всех формах и отчётах; прошлые проводки не меняются.",
    kinds: { REVENUE: "Выручка", OTHER_INCOME: "Прочие доходы", COST_OF_SALES: "Себестоимость услуг", OPERATING_EXPENSE: "Операционные расходы", DEPRECIATION: "Амортизация ОС", AMORTIZATION: "Амортизация НМА", INTEREST: "Проценты", TAX: "Налог на прибыль", OTHER_EXPENSE: "Прочие расходы" },
    add: "Добавить",
    name: "Название",
    parent: "Подкатегория для",
    line: "Строка P&L",
    newLine: "+ новая строка с этим названием",
    sameAsParent: "как у родителя / по умолчанию",
    archived: "архив",
    remapHint: "Смена строки влияет только на новые проводки.",
  },
  en: {
    title: "Categories",
    description: "Income and expense categories, subcategories and the P&L lines they report to. New categories are available in every form and report immediately; past entries do not change.",
    kinds: { REVENUE: "Revenue", OTHER_INCOME: "Other income", COST_OF_SALES: "Cost of services", OPERATING_EXPENSE: "Operating expenses", DEPRECIATION: "Depreciation", AMORTIZATION: "Amortization", INTEREST: "Interest", TAX: "Income tax", OTHER_EXPENSE: "Other expenses" },
    add: "Add",
    name: "Name",
    parent: "Subcategory of",
    line: "P&L line",
    newLine: "+ new line with this name",
    sameAsParent: "same as parent / default",
    archived: "archived",
    remapHint: "Changing the line affects new postings only.",
  },
}

export function CategoriesView({ locale, data, canEdit }: { locale: Locale; data: Data; canEdit: boolean }) {
  const t = T[locale]
  const router = useRouter()
  const [, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ name: "", kind: "OPERATING_EXPENSE", parentId: "", ledgerAccountId: "" })
  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    const r = await fn()
    if (!r.ok) setError(r.message ?? "Error")
    else {
      setError(null)
      start(() => router.refresh())
    }
    return r.ok
  }
  const linesFor = (kind: string) => data.accounts.filter((a) => a.subtype === SUBTYPE[kind as (typeof KINDS)[number]])

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{t.title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
      </div>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-red-200">{error}</p>}
      {canEdit && (
        <form
          className="grid gap-3 rounded-2xl border border-primary/30 bg-card/40 p-4 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await run(() => createCategoryAction(form))) setForm((f) => ({ ...f, name: "", parentId: "" }))
          }}
        >
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.name} required maxLength={120} aria-label={t.name} />
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, parentId: "", ledgerAccountId: "" })} aria-label="Kind">
            {KINDS.map((k) => <option key={k} value={k}>{t.kinds[k]}</option>)}
          </Select>
          <Select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} aria-label={t.parent}>
            <option value="">{t.parent}: —</option>
            {data.categories.filter((c) => c.kind === form.kind && !c.parentId && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={form.ledgerAccountId} onChange={(e) => setForm({ ...form, ledgerAccountId: e.target.value })} aria-label={t.line}>
            <option value="">{t.line}: {t.sameAsParent}</option>
            {linesFor(form.kind).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            <option value="new">{t.newLine}</option>
          </Select>
          <Button type="submit"><Plus /> {t.add}</Button>
        </form>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {KINDS.map((kind) => {
          const items = data.categories.filter((c) => c.kind === kind)
          if (!items.length) return null
          const roots = items.filter((c) => !c.parentId || !items.some((p) => p.id === c.parentId))
          return (
            <section key={kind} className="rounded-2xl border border-border bg-card/60 p-5">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t.kinds[kind]}</p>
              {roots.map((root) => [root, ...items.filter((c) => c.parentId === root.id)].map((c, i) => (
                <div key={c.id} className={cn("flex items-center gap-3 border-t border-border/40 py-1.5 text-sm first:border-0", i > 0 && "pl-6", c.archived && "text-muted-foreground line-through")}>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {canEdit ? (
                    <Select value={c.account?.id ?? ""} onChange={(e) => run(() => updateCategoryAction(c.id, { ledgerAccountId: e.target.value }))} className="h-7 w-56 text-xs" aria-label={t.line} title={t.remapHint}>
                      {linesFor(kind).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                    </Select>
                  ) : (
                    <span className="text-xs text-muted-foreground">{c.account?.label}</span>
                  )}
                  {canEdit && (
                    <button type="button" onClick={() => run(() => updateCategoryAction(c.id, { archived: !c.archived }))} className="text-muted-foreground hover:text-primary" aria-label={t.archived}>
                      {c.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                    </button>
                  )}
                </div>
              )))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
