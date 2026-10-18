import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import { monthEnd, monthLabel, monthStart, type Month } from "@/lib/period"

export type Tx = Prisma.TransactionClient

/**
 * Returns the organization's period for a month, creating it (OPEN) if it does not exist yet.
 * Never updates an existing period, so closed/locked months are left untouched.
 */
export async function ensurePeriod(tx: Tx, organizationId: string, m: Month) {
  const existing = await tx.financialPeriod.findUnique({
    where: { organizationId_year_month: { organizationId, year: m.year, month: m.month } },
  })
  if (existing) return existing

  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } })
  const fiscalYear = m.month >= org.fiscalYearStartMonth || org.fiscalYearStartMonth === 1 ? m.year : m.year - 1
  return tx.financialPeriod.create({
    data: { organizationId, year: m.year, month: m.month, fiscalYear, startDate: monthStart(m), endDate: monthEnd(m) },
  })
}

/**
 * CLOSED and LOCKED months refuse changes (the database enforces this too). A month under review
 * (CLOSING) can only be changed by people who close periods (period:close), as the schema intends.
 */
export function assertPeriodOpen(period: { status: string }, m: Month, user?: SessionUser) {
  if (period.status === "CLOSED" || period.status === "LOCKED") {
    throw new UserInputError(`${monthLabel(m)} is closed. Its records can no longer be changed.`)
  }
  if (period.status === "CLOSING" && user && !user.permissions.has("period:close")) {
    throw new UserInputError(`${monthLabel(m)} is under review before closing. Only people who close periods can change it.`)
  }
}

/**
 * FX rate to the base currency for a month (rate stored on the month's last day).
 * 1 for the base currency itself; otherwise the stored rate, or a validation error.
 */
export async function fxRateFor(tx: Tx, user: SessionUser, currency: string, m: Month, override?: Decimal | null) {
  if (currency === user.baseCurrency) return new Decimal(1)
  if (override) return override
  const rate = await tx.exchangeRate.findUnique({
    where: {
      organizationId_baseCurrency_quoteCurrency_rateDate: {
        organizationId: user.organizationId,
        baseCurrency: currency,
        quoteCurrency: user.baseCurrency,
        rateDate: monthEnd(m),
      },
    },
  })
  if (!rate) {
    throw new UserInputError(
      `No ${currency}→${user.baseCurrency} rate for ${monthLabel(m)}. Enter the rate on the form or in Settings → Exchange rates.`,
    )
  }
  return new Decimal(rate.rate)
}

export async function audit(
  tx: Tx,
  user: SessionUser,
  action: string,
  entityType: string,
  entityId: string | null,
  after?: Prisma.InputJsonValue,
) {
  await tx.auditLog.create({
    data: {
      organizationId: user.organizationId,
      actorType: "USER",
      actorUserId: user.id,
      action,
      entityType,
      entityId,
      after,
    },
  })
}

/** Uppercase code from a name, made unique with a numeric suffix. */
export async function uniqueCode(name: string, exists: (code: string) => Promise<boolean>) {
  const base = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase().slice(0, 24) || "ITEM"
  let code = base
  for (let i = 2; await exists(code); i++) code = `${base}-${i}`
  return code
}
