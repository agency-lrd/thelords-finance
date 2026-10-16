import "server-only"

import type { FinancialAccountType } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

export const ACCOUNT_TYPES = ["BANK", "CRYPTO_WALLET", "PAYMENT_PROVIDER", "CASH", "CREDIT_CARD", "LOAN"] as const satisfies readonly FinancialAccountType[]

/** Company money accounts with their balance derived from posted journal lines (base currency). */
export async function listFinancialAccounts(user: SessionUser, db: Db = prisma) {
  const accounts = await db.financialAccount.findMany({
    where: { organizationId: user.organizationId },
    include: { ledgerAccount: true },
    orderBy: [{ closedAt: "asc" }, { name: "asc" }],
  })
  const balances = await db.journalLine.groupBy({
    by: ["ledgerAccountId"],
    where: { ledgerAccountId: { in: accounts.map((a) => a.ledgerAccountId) }, journalEntry: { status: { in: ["POSTED", "REVERSED"] } } },
    _sum: { debit: true, credit: true },
  })
  const byAccount = new Map(balances.map((b) => [b.ledgerAccountId, new Decimal(b._sum.debit ?? 0).sub(new Decimal(b._sum.credit ?? 0))]))
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    institution: a.institution,
    closed: !!a.closedAt,
    code: a.ledgerAccount.code,
    // Liabilities (cards, loans) have a credit balance; show them as positive amounts owed.
    balance: (a.type === "CREDIT_CARD" || a.type === "LOAN" ? (byAccount.get(a.ledgerAccountId) ?? new Decimal(0)).neg() : (byAccount.get(a.ledgerAccountId) ?? new Decimal(0))).toString(),
  }))
}

/** Creates a money account and its ledger account (cash under 1000, cards/loans as liabilities). */
export async function createFinancialAccount(
  user: SessionUser,
  input: { name: string; type: FinancialAccountType; currency: string; institution: string | null },
  db: Db = prisma,
) {
  if (!user.permissions.has("ledger:manage")) throw new UserInputError("You do not have permission to manage accounts.")
  return inTx(db, async (tx) => {
    const name = input.name.trim()
    if (!name || name.length > 120) throw new UserInputError("Enter an account name (max 120 characters).")
    if (!["USD", "EUR", "GBP", "USDT"].includes(input.currency)) throw new UserInputError("Choose a supported currency.")
    const liability = input.type === "CREDIT_CARD" || input.type === "LOAN"
    const prefix = liability ? (input.type === "LOAN" ? "26" : "20") : "10"
    const parent = liability ? null : await tx.ledgerAccount.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: "1000" } } })

    let n = 10
    while (await tx.ledgerAccount.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: `${prefix}${n}` } } })) n++
    if (n > 99) throw new UserInputError("Too many accounts of this type.")

    const ledger = await tx.ledgerAccount.create({
      data: {
        organizationId: user.organizationId,
        parentId: parent?.id ?? null,
        code: `${prefix}${n}`,
        name,
        type: liability ? "LIABILITY" : "ASSET",
        subtype: liability ? (input.type === "LOAN" ? "LONG_TERM_DEBT" : "SHORT_TERM_DEBT") : "CASH",
        normalBalance: liability ? "CREDIT" : "DEBIT",
        cashFlowActivity: liability ? "FINANCING" : "NONE",
        currency: input.currency,
      },
    })
    const account = await tx.financialAccount.create({
      data: { organizationId: user.organizationId, ledgerAccountId: ledger.id, type: input.type, name, currency: input.currency, institution: input.institution },
    })
    await audit(tx, user, "financial_account.create", "financial_account", account.id, { name, type: input.type, currency: input.currency })
    return account
  })
}
