import { ArrowRight, CircleCheck, TriangleAlert } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"
import { cn } from "cn"

import { Greeting } from "@/components/dashboard/greeting"
import { can, requireUser } from "@/lib/auth/session"
import { getSheet } from "@/lib/data/sheet"
import { fill } from "@/lib/i18n/dictionaries"
import { formatAmount, monthName } from "@/lib/i18n/format"
import { getDictionary } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { currentMonth } from "@/lib/period"

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-muted/20" />}>
      <Dashboard />
    </Suspense>
  )
}

const sum = (values: (string | null)[]) => values.reduce((acc, v) => (v ? acc.add(v) : acc), new Decimal(0))

async function Dashboard() {
  const user = await requireUser()
  const { t, locale } = await getDictionary()
  const month = currentMonth()
  const title = monthName(month.year, month.month, locale)
  const firstName = (user.displayName ?? user.email.split("@")[0]).split(/\s+/)[0]
  const sheet = can(user, "payroll:read") && can(user, "salary:read") ? await getSheet(user, month) : null
  const rows = (sheet?.rows ?? []).filter((r) => r.currency === user.baseCurrency)
  const money = (value: Decimal) => formatAmount(value.toString(), user.baseCurrency, locale)

  const calculated = sum(rows.map((r) => r.calculated))
  const approved = sum(rows.map((r) => r.approved))
  const paid = sum(rows.map((r) => r.paid))
  const outstanding = sum(rows.map((r) => r.outstanding))
  const confirmed = rows.filter((r) => r.confirmed && !r.stale).length
  const progress = approved.isZero() ? 0 : Math.min(100, paid.div(approved).mul(100).toNumber())

  const byDept = new Map<string, Decimal>()
  for (const r of rows) byDept.set(r.departmentName ?? t.sheet.noDepartment, (byDept.get(r.departmentName ?? t.sheet.noDepartment) ?? new Decimal(0)).add(r.calculated))
  const departments = [...byDept.entries()].sort((a, b) => b[1].comparedTo(a[1]))

  const all = sheet?.rows ?? []
  const attention = [
    { n: all.filter((r) => !r.confirmed || r.stale).length, text: t.dashboard.unconfirmed },
    { n: all.filter((r) => r.pendingAdjustments > 0).length, text: t.dashboard.pendingApprovals },
    { n: all.filter((r) => !r.wallet).length, text: t.dashboard.noWallet },
    { n: all.filter((r) => !r.fix).length, text: t.dashboard.noFix },
  ].filter((a) => a.n > 0)

  return (
    <div className="flex flex-col gap-8">
      <Greeting name={firstName} />

      {!sheet ? null : rows.length === 0 && all.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/15 via-card/60 to-card/40 p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{fill(t.dashboard.payrollMonth, { month: title })}</p>
          <p className="text-lg">{t.dashboard.noSheet}</p>
          <Link href="/payroll" className="inline-flex items-center gap-2 rounded-full border border-primary/60 px-4 py-2 text-sm text-primary hover:bg-primary/10">
            {t.dashboard.openSheet} <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
          {/* Hero: payroll this month */}
          <section className="relative grid overflow-hidden rounded-3xl border border-primary/40 bg-[radial-gradient(ellipse_at_top_left,rgba(190,24,93,0.35),rgba(20,14,20,0.9)_60%)] md:grid-cols-[1.6fr_1fr]">
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:28px_28px]" />
            <div className="relative flex flex-col justify-between gap-10 p-8">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-foreground/70">{fill(t.dashboard.payrollMonth, { month: title })}</p>
                <p className="mt-4 font-display text-5xl font-black tracking-tight italic sm:text-6xl">{money(approved.isZero() ? calculated : approved)}</p>
                <p className="mt-3 text-sm text-muted-foreground">
                  {approved.isZero() ? t.dashboard.calculated : t.dashboard.approved} · {t.dashboard.confirmedRows}: {confirmed}/{all.length}
                </p>
              </div>
              <div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-white" style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-3 flex justify-between text-sm text-foreground/80">
                  <span>{t.dashboard.paid}: {money(paid)}</span>
                  <span>{t.dashboard.outstanding}: {money(outstanding)}</span>
                </div>
              </div>
            </div>
            <div className="relative flex flex-col divide-y divide-white/10 border-t border-white/10 md:border-t-0 md:border-l">
              {[
                [t.dashboard.headcount, String(all.length)],
                [t.dashboard.calculated, money(calculated)],
                [t.dashboard.paid, money(paid)],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-1 flex-col justify-center gap-2 p-7">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
                  <p className="font-display text-2xl font-black italic">{value}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Payroll by department */}
          <section className="rounded-3xl border border-border bg-card/60 p-7">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t.dashboard.byDepartment}</p>
              <Link href="/payroll" className="text-sm text-muted-foreground hover:text-primary">{t.nav.sheet} →</Link>
            </div>
            <div className="mt-6 flex flex-col gap-4">
              {departments.map(([name, value]) => (
                <div key={name} className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-sm">
                    <span>{name}</span>
                    <span className="font-mono text-muted-foreground">{money(value)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${calculated.isZero() ? 0 : value.div(calculated).mul(100).toNumber()}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Attention */}
          <section className="rounded-3xl border border-border bg-card/60 p-7 xl:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{t.dashboard.attention}</p>
            <div className="mt-5 flex flex-wrap gap-3">
              {attention.length === 0 ? (
                <span className="flex items-center gap-2 text-sm text-foreground/80"><CircleCheck className="size-4 text-primary" /> {t.dashboard.noAttention}</span>
              ) : (
                attention.map((a) => (
                  <Link key={a.text} href="/payroll" className={cn("flex items-center gap-2 rounded-2xl border border-border px-4 py-3 text-sm hover:border-primary/50")}>
                    <TriangleAlert className="size-4 text-amber-400" /> {fill(a.text, { n: a.n })}
                  </Link>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
