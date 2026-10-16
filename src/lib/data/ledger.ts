import "server-only"

import type { JournalSource } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"

import type { Tx } from "./common"

export type JournalLineInput = {
  accountId: string
  debit?: Decimal
  credit?: Decimal
  description?: string
  departmentId?: string | null
  employeeId?: string | null
  projectId?: string | null
  clientId?: string | null
  categoryId?: string | null
}

/** Ledger account id by chart-of-accounts code (e.g. "2100" payroll payable). */
export async function accountByCode(tx: Tx, organizationId: string, code: string) {
  const account = await tx.ledgerAccount.findUnique({ where: { organizationId_code: { organizationId, code } } })
  if (!account) throw new UserInputError(`Ledger account ${code} is missing from the chart of accounts.`)
  return account.id
}

/**
 * Posts a balanced double-entry journal entry. Lines with a zero amount are dropped; amounts are in
 * the base currency rounded to 8 decimals. The database re-checks balance, period and permission
 * (the poster must hold journal:post), so a bad entry can never be stored.
 */
export async function postJournal(
  tx: Tx,
  user: SessionUser,
  input: { periodId: string; entryDate: Date; description: string; source: JournalSource; lines: JournalLineInput[] },
) {
  if (!user.permissions.has("journal:post")) {
    throw new UserInputError("Posting to the ledger requires the journal:post permission (CFO or Owner).")
  }
  const lines = input.lines
    .map((line) => ({
      ...line,
      debit: (line.debit ?? new Decimal(0)).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
      credit: (line.credit ?? new Decimal(0)).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    }))
    .filter((line) => !line.debit.isZero() || !line.credit.isZero())
  const debit = lines.reduce((acc, l) => acc.add(l.debit), new Decimal(0))
  const credit = lines.reduce((acc, l) => acc.add(l.credit), new Decimal(0))
  if (!debit.eq(credit)) throw new Error(`Unbalanced journal entry: debit ${debit} credit ${credit}`)
  if (debit.isZero()) return null

  // Sequential numbering per organization, serialized with a transaction advisory lock.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`journal_number:${user.organizationId}`}, 0))`
  const last = await tx.journalEntry.aggregate({ where: { organizationId: user.organizationId }, _max: { entryNumber: true } })

  const entry = await tx.journalEntry.create({
    data: {
      organizationId: user.organizationId,
      periodId: input.periodId,
      entryNumber: (last._max.entryNumber ?? 0) + 1,
      entryDate: input.entryDate,
      description: input.description,
      source: input.source,
      createdById: user.id,
      lines: {
        create: lines.map((line, index) => ({
          lineNumber: index + 1,
          ledgerAccountId: line.accountId,
          debit: line.debit.toString(),
          credit: line.credit.toString(),
          description: line.description,
          departmentId: line.departmentId ?? null,
          employeeId: line.employeeId ?? null,
          projectId: line.projectId ?? null,
          clientId: line.clientId ?? null,
          categoryId: line.categoryId ?? null,
        })),
      },
    },
  })
  return tx.journalEntry.update({
    where: { id: entry.id },
    data: { status: "POSTED", postedById: user.id, postedAt: new Date() },
  })
}
