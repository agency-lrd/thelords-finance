import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"

import type { AiLimits } from "./config"

/*
 * Rate and spending limits, computed from the stored (append-only) chat messages so they hold across
 * server instances. Costs are estimates from token usage and the published per-token prices.
 */

export type LimitBlock = { code: "rate_minute" | "rate_day" | "user_budget" | "org_budget" | "disabled"; retryAfterSeconds: number | null }

export async function usageSnapshot(user: SessionUser, db: Db = prisma, now = new Date()) {
  const minuteAgo = new Date(now.getTime() - 60_000)
  const dayAgo = new Date(now.getTime() - 86_400_000)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const [row] = await db.$queryRaw<{ minute: number; day: number; user_day_usd: string; org_month_usd: string }[]>`
    SELECT
      count(*) FILTER (WHERE user_id = ${user.id}::uuid AND role = 'USER' AND created_at >= ${minuteAgo})::int AS minute,
      count(*) FILTER (WHERE user_id = ${user.id}::uuid AND role = 'USER' AND created_at >= ${dayAgo})::int AS day,
      coalesce(sum(cost_usd) FILTER (WHERE user_id = ${user.id}::uuid AND created_at >= ${dayAgo}), 0)::text AS user_day_usd,
      coalesce(sum(cost_usd) FILTER (WHERE created_at >= ${monthStart}), 0)::text AS org_month_usd
    FROM ai_messages
    WHERE organization_id = ${user.organizationId}::uuid AND created_at >= least(${dayAgo}::timestamptz, ${monthStart}::timestamptz)`
  return { minute: row.minute, day: row.day, userDayUsd: Number(row.user_day_usd), orgMonthUsd: Number(row.org_month_usd) }
}

/** Why a new request may not start now, or null when it may. */
export function checkLimits(limits: AiLimits, usage: Awaited<ReturnType<typeof usageSnapshot>>): LimitBlock | null {
  if (limits.userDailyUsd <= 0 || limits.orgMonthlyUsd <= 0) return { code: "disabled", retryAfterSeconds: null }
  if (usage.minute >= limits.perMinute) return { code: "rate_minute", retryAfterSeconds: 60 }
  if (usage.day >= limits.perDay) return { code: "rate_day", retryAfterSeconds: 3600 }
  if (usage.userDayUsd >= limits.userDailyUsd) return { code: "user_budget", retryAfterSeconds: 3600 }
  if (usage.orgMonthUsd >= limits.orgMonthlyUsd) return { code: "org_budget", retryAfterSeconds: null }
  return null
}

/** Dollars this answer may still spend before it is stopped. */
export function remainingBudget(limits: AiLimits, usage: Awaited<ReturnType<typeof usageSnapshot>>) {
  return Math.max(0, Math.min(limits.userDailyUsd - usage.userDayUsd, limits.orgMonthlyUsd - usage.orgMonthUsd))
}
