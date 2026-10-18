import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import { monthOfDate } from "@/lib/period"
import { allocateDistribution } from "@/lib/reports/statements"

import { assertPeriodOpen, audit, ensurePeriod } from "./common"
import { inTx, prisma, type Db } from "./db"
import { accountByCode, postJournal } from "./ledger"

/*
 * Owners and investor distributions.
 *  - Ownership and profit participation are effective-dated stakes (the database refuses overlaps and
 *    more than 100% in total), so changing shares never rewrites past allocations.
 *  - A distribution starts from an explicitly entered distributable amount: accounting net profit is
 *    shown for reference only and is never assumed to be distributable.
 *  - Allocations snapshot the share used. Approval posts Dr Owner distributions / Cr Distributions
 *    payable (equity and a liability: no effect on EBITDA or any expense); each payment posts
 *    Dr Distributions payable / Cr cash.
 */

const today = () => new Date(new Date().toISOString().slice(0, 10))

function need(user: SessionUser, permission: "ownership:read" | "ownership:manage" | "distribution:manage" | "distribution:approve") {
  if (!user.permissions.has(permission)) throw new UserInputError("You do not have permission to do this.")
}

export async function listOwners(user: SessionUser, asOf: Date = today(), db: Db = prisma) {
  need(user, "ownership:read")
  const shareholders = await db.shareholder.findMany({
    where: { organizationId: user.organizationId },
    include: {
      stakes: { orderBy: { validFrom: "desc" } },
      allocations: { include: { distribution: { select: { status: true, declaredDate: true, currency: true } } } },
      transactions: { where: { status: "POSTED", type: { in: ["OWNER_CONTRIBUTION", "OWNER_WITHDRAWAL"] } }, select: { type: true, baseAmount: true } },
    },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
  })
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  return shareholders.map((s) => {
    const current = s.stakes.find((k) => k.validFrom <= asOf && (!k.validTo || k.validTo > asOf)) ?? null
    const approved = s.allocations.filter((a) => a.distribution.status === "APPROVED" || a.distribution.status === "PAID")
    const allocated = approved.reduce((acc, a) => acc.add(a.amount.toString()), new Decimal(0))
    const paid = approved.filter((a) => a.paidAt).reduce((acc, a) => acc.add(a.amount.toString()), new Decimal(0))
    const contributed = s.transactions.filter((t) => t.type === "OWNER_CONTRIBUTION").reduce((a, t) => a.add(t.baseAmount.toString()), new Decimal(0)).add(s.stakes.reduce((a, k) => a.add(k.capitalContributed.toString()), new Decimal(0)))
    const withdrawn = s.transactions.filter((t) => t.type === "OWNER_WITHDRAWAL").reduce((a, t) => a.add(t.baseAmount.toString()), new Decimal(0))
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      email: s.email,
      archived: !!s.archivedAt,
      ownershipShare: current ? current.ownershipShare.toString() : null,
      profitShare: current ? (current.profitShare ?? current.ownershipShare).toString() : null,
      stakeFrom: current ? iso(current.validFrom) : null,
      capitalContributed: contributed.toString(),
      withdrawn: withdrawn.toString(),
      allocated: allocated.toString(),
      paid: paid.toString(),
      outstanding: allocated.sub(paid).toString(),
      history: s.stakes.map((k) => ({ from: iso(k.validFrom)!, to: iso(k.validTo), ownership: k.ownershipShare.toString(), profit: (k.profitShare ?? k.ownershipShare).toString() })),
    }
  })
}

export async function saveOwner(user: SessionUser, input: { id: string | null; name: string; type: "INDIVIDUAL" | "COMPANY"; email: string | null }, db: Db = prisma) {
  need(user, "ownership:manage")
  const name = input.name.trim()
  if (!name || name.length > 160) throw new UserInputError("Enter the owner's name.")
  return inTx(db, async (tx) => {
    if (input.id) {
      const { count } = await tx.shareholder.updateMany({ where: { id: input.id, organizationId: user.organizationId }, data: { name, type: input.type, email: input.email } })
      if (!count) throw new UserInputError("Owner not found.")
      await audit(tx, user, "shareholder.update", "shareholder", input.id, { name })
      return input.id
    }
    const owner = await tx.shareholder.create({ data: { organizationId: user.organizationId, name, type: input.type, email: input.email } })
    await audit(tx, user, "shareholder.create", "shareholder", owner.id, { name })
    return owner.id
  })
}

/**
 * Sets an owner's ownership and profit participation from a date. The stake in force at that date ends
 * the day before; earlier stakes and every past allocation stay as they were.
 */
export async function setStake(user: SessionUser, shareholderId: string, input: { ownershipShare: Decimal; profitShare: Decimal | null; validFrom: Date }, db: Db = prisma) {
  need(user, "ownership:manage")
  if (input.ownershipShare.lt(0) || input.ownershipShare.gt(1)) throw new UserInputError("Ownership must be between 0% and 100%.")
  if (input.profitShare && (input.profitShare.lt(0) || input.profitShare.gt(1))) throw new UserInputError("Profit participation must be between 0% and 100%.")
  return inTx(db, async (tx) => {
    const owner = await tx.shareholder.findFirst({ where: { id: shareholderId, organizationId: user.organizationId } })
    if (!owner) throw new UserInputError("Owner not found.")
    const later = await tx.ownershipStake.findFirst({ where: { shareholderId, validFrom: { gt: input.validFrom } }, orderBy: { validFrom: "asc" } })
    const current = await tx.ownershipStake.findFirst({ where: { shareholderId, validFrom: { lte: input.validFrom }, OR: [{ validTo: null }, { validTo: { gt: input.validFrom } }] } })
    if (current) {
      const used = await tx.distributionAllocation.count({ where: { ownershipStakeId: current.id } })
      if (current.validFrom.getTime() === input.validFrom.getTime() && used === 0) {
        if (input.ownershipShare.isZero()) await tx.ownershipStake.delete({ where: { id: current.id } })
        else await tx.ownershipStake.update({ where: { id: current.id }, data: { ownershipShare: input.ownershipShare.toString(), profitShare: input.profitShare?.toString() ?? null } })
        await audit(tx, user, "ownership.update", "shareholder", shareholderId, { ownership: input.ownershipShare.toString(), profit: input.profitShare?.toString() ?? null })
        return
      }
      await tx.ownershipStake.update({ where: { id: current.id }, data: { validTo: input.validFrom } })
    }
    if (!input.ownershipShare.isZero()) {
      await tx.ownershipStake.create({
        data: { shareholderId, ownershipShare: input.ownershipShare.toString(), profitShare: input.profitShare?.toString() ?? null, currency: user.baseCurrency, validFrom: input.validFrom, validTo: current?.validTo ?? later?.validFrom ?? null },
      })
    }
    await audit(tx, user, "ownership.set", "shareholder", shareholderId, { ownership: input.ownershipShare.toString(), profit: input.profitShare?.toString() ?? null, from: input.validFrom.toISOString().slice(0, 10) })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Distributions
// ─────────────────────────────────────────────────────────────────────────────

export async function listDistributions(user: SessionUser, db: Db = prisma) {
  need(user, "ownership:read")
  const rows = await db.distribution.findMany({
    where: { organizationId: user.organizationId },
    include: { allocations: { include: { shareholder: { select: { name: true } }, financialAccount: { select: { name: true } } } }, approvedBy: { select: { email: true } } },
    orderBy: [{ declaredDate: "desc" }, { createdAt: "desc" }],
    take: 100,
  })
  return rows.map((d) => ({
    id: d.id,
    type: d.type,
    status: d.status,
    declaredDate: d.declaredDate.toISOString().slice(0, 10),
    basisAmount: d.basisAmount?.toString() ?? null,
    totalAmount: d.totalAmount.toString(),
    retained: d.basisAmount ? new Decimal(d.basisAmount.toString()).sub(d.totalAmount.toString()).toString() : null,
    currency: d.currency,
    notes: d.notes,
    approvedBy: d.approvedBy?.email ?? null,
    allocations: d.allocations.map((a) => ({
      id: a.id,
      shareholderId: a.shareholderId,
      name: a.shareholder.name,
      share: a.shareApplied.toString(),
      amount: a.amount.toString(),
      paidAt: a.paidAt?.toISOString().slice(0, 10) ?? null,
      account: a.financialAccount?.name ?? null,
      reference: a.paymentReference,
    })),
  }))
}

/**
 * Prepares a distribution. basisAmount is the distributable profit the owners decided on; payoutRate
 * (0-1) is the part of it paid out now (the rest is reinvested). Allocations use each owner's profit
 * participation in force on the declared date.
 */
export async function createDistribution(user: SessionUser, input: { declaredDate: Date; basisAmount: Decimal; payoutRate: Decimal; notes: string | null }, db: Db = prisma) {
  need(user, "distribution:manage")
  if (input.basisAmount.lte(0)) throw new UserInputError("Enter the distributable profit.")
  if (input.payoutRate.lte(0) || input.payoutRate.gt(1)) throw new UserInputError("The payout must be between 1% and 100% of the distributable profit.")
  return inTx(db, async (tx) => {
    const m = monthOfDate(input.declaredDate)
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m, user)
    const stakes = await tx.ownershipStake.findMany({
      where: { shareholder: { organizationId: user.organizationId, archivedAt: null }, validFrom: { lte: input.declaredDate }, OR: [{ validTo: null }, { validTo: { gt: input.declaredDate } }] },
    })
    if (stakes.length === 0) throw new UserInputError("Set the owners' shares first.")
    const pool = input.basisAmount.mul(input.payoutRate).toDecimalPlaces(2, Decimal.ROUND_DOWN)
    const { allocations, allocated } = allocateDistribution(pool, stakes.map((s) => ({ id: s.id, share: (s.profitShare ?? s.ownershipShare).toString() })))
    const distribution = await tx.distribution.create({
      data: {
        organizationId: user.organizationId,
        periodId: period.id,
        type: "PROFIT_SHARE",
        declaredDate: input.declaredDate,
        basisAmount: input.basisAmount.toString(),
        totalAmount: allocated,
        currency: user.baseCurrency,
        notes: input.notes,
        allocations: {
          create: allocations.map((a) => {
            const stake = stakes.find((s) => s.id === a.id)!
            return { shareholderId: stake.shareholderId, ownershipStakeId: stake.id, shareApplied: a.share, amount: a.amount }
          }),
        },
      },
    })
    await audit(tx, user, "distribution.create", "distribution", distribution.id, { basis: input.basisAmount.toString(), payoutRate: input.payoutRate.toString(), total: allocated })
    return distribution
  })
}

export async function approveDistribution(user: SessionUser, id: string, db: Db = prisma) {
  need(user, "distribution:approve")
  return inTx(db, async (tx) => {
    const d = await tx.distribution.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!d || d.status !== "DRAFT") throw new UserInputError("Only a draft distribution can be approved.")
    const entry = await postJournal(tx, user, {
      periodId: d.periodId,
      entryDate: d.declaredDate,
      description: `Owner distribution ${d.declaredDate.toISOString().slice(0, 10)}`,
      source: "DISTRIBUTION",
      lines: [
        { accountId: await accountByCode(tx, user.organizationId, "3200"), debit: new Decimal(d.totalAmount.toString()) },
        { accountId: await accountByCode(tx, user.organizationId, "2700"), credit: new Decimal(d.totalAmount.toString()) },
      ],
    })
    await tx.distribution.update({ where: { id }, data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date(), journalEntryId: entry?.id ?? null } })
    await audit(tx, user, "distribution.approve", "distribution", id, { total: d.totalAmount.toString() })
  })
}

export async function cancelDistribution(user: SessionUser, id: string, db: Db = prisma) {
  need(user, "distribution:manage")
  return inTx(db, async (tx) => {
    const d = await tx.distribution.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!d || d.status !== "DRAFT") throw new UserInputError("Only a draft distribution can be cancelled.")
    await tx.distribution.update({ where: { id }, data: { status: "CANCELLED" } })
    await audit(tx, user, "distribution.cancel", "distribution", id)
  })
}

export async function payAllocation(user: SessionUser, allocationId: string, input: { financialAccountId: string; date: Date; reference: string | null }, db: Db = prisma) {
  need(user, "distribution:manage")
  return inTx(db, async (tx) => {
    const a = await tx.distributionAllocation.findFirst({ where: { id: allocationId, distribution: { organizationId: user.organizationId } }, include: { distribution: true, shareholder: true } })
    if (!a) throw new UserInputError("Allocation not found.")
    if (a.distribution.status !== "APPROVED") throw new UserInputError("Approve the distribution before paying it.")
    if (a.paidAt) throw new UserInputError("Already paid.")
    const account = await tx.financialAccount.findFirst({ where: { id: input.financialAccountId, organizationId: user.organizationId } })
    if (!account) throw new UserInputError("Choose the company account.")
    const m = monthOfDate(input.date)
    const period = await ensurePeriod(tx, user.organizationId, m)
    assertPeriodOpen(period, m, user)
    const amount = new Decimal(a.amount.toString())
    await postJournal(tx, user, {
      periodId: period.id,
      entryDate: input.date,
      description: `Distribution paid: ${a.shareholder.name}`,
      source: "DISTRIBUTION",
      lines: [
        { accountId: await accountByCode(tx, user.organizationId, "2700"), debit: amount },
        { accountId: account.ledgerAccountId, credit: amount },
      ],
    })
    await tx.distributionAllocation.update({ where: { id: allocationId }, data: { paidAt: input.date, financialAccountId: account.id, paymentReference: input.reference } })
    const unpaid = await tx.distributionAllocation.count({ where: { distributionId: a.distributionId, paidAt: null } })
    if (unpaid === 0) await tx.distribution.update({ where: { id: a.distributionId }, data: { status: "PAID" } })
    await audit(tx, user, "distribution.pay", "distribution_allocation", allocationId, { amount: amount.toString() })
  })
}
