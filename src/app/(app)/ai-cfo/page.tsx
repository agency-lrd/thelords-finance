import { FileText, Lock, Sparkles } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { AiChat } from "@/components/ai-cfo/chat"
import { Insights } from "@/components/ai-cfo/insights"
import { PeriodPicker } from "@/components/reports/period-picker"
import { PageSkeleton } from "@/components/shared/page-skeleton"
import { aiConfigured, aiLimits } from "@/lib/ai/config"
import { listConversations, monthlyUsage } from "@/lib/ai/conversations"
import { requirePageAccess } from "@/lib/auth/session"
import { prisma } from "@/lib/db"
import { aiTexts } from "@/lib/i18n/ai-cfo"
import { getDictionary } from "@/lib/i18n/server"
import { reportParams } from "@/lib/reports/params"

export const metadata: Metadata = { title: "AI CFO" }

export default function AiCfoPage({ searchParams }: PageProps<"/ai-cfo">) {
  return (
    <Suspense fallback={<PageSkeleton title="AI CFO" />}>
      <AiCfo searchParams={searchParams} />
    </Suspense>
  )
}

async function AiCfo({ searchParams }: { searchParams: PageProps<"/ai-cfo">["searchParams"] }) {
  const user = await requirePageAccess("reports:read")
  const { locale } = await getDictionary()
  const t = aiTexts[locale]
  const { period } = reportParams(await searchParams)
  // Only presence is checked; the key itself is never read into the page.
  const configured = aiConfigured()
  const limits = aiLimits()
  const [departments, conversations, usage] = [
    await prisma.department.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    await listConversations(user),
    await monthlyUsage(user),
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="flex items-center gap-3 font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">
            <Sparkles className="size-7 text-primary" /> {t.title}
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        </div>
        <Link href={`/ai-cfo/report?p=${period.length === 7 ? period : ""}`} className="inline-flex items-center gap-2 self-start rounded-xl border border-primary/40 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 lg:self-auto">
          <FileText className="size-4" /> {t.report}
        </Link>
      </div>
      <PeriodPicker value={period} />

      {!configured && (
        <div className="flex items-start gap-3 rounded-2xl border border-border p-4">
          <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">{t.notConfigured}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t.notConfiguredText}</p>
          </div>
        </div>
      )}

      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl border border-border bg-card/30" />}>
        <Insights user={user} period={period} locale={locale} />
      </Suspense>

      <AiChat key={period} configured={configured} period={period} departments={departments} initialConversations={conversations} />
      {configured && (
        <p className="text-[11px] text-muted-foreground">
          {t.chat.usage}: {locale === "ru" ? "вы" : "you"} ${usage.userUsd.toFixed(2)} ({locale === "ru" ? "лимит" : "limit"} ${limits.userDailyUsd.toFixed(0)}/{locale === "ru" ? "день" : "day"}) · {locale === "ru" ? "компания" : "company"} ${usage.orgUsd.toFixed(2)} / ${limits.orgMonthlyUsd.toFixed(0)} · {limits.model}
        </p>
      )}
    </div>
  )
}
