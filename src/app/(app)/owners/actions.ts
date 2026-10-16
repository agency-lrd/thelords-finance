"use server"

import { revalidatePath } from "next/cache"

import { authorize } from "@/lib/auth/session"
import { approveDistribution, cancelDistribution, createDistribution, payAllocation, saveOwner, setStake } from "@/lib/data/owners"
import { toActionError, UserInputError } from "@/lib/forms"
import { normalizeNumber } from "@/lib/i18n/format"
import { Decimal } from "@/lib/money"

type Result = { ok: true } | { ok: false; message: string }
const fail = (e: unknown): Result => ({ ok: false, message: toActionError(e).message ?? "Error" })
const done = (): Result => {
  for (const p of ["/owners", "/", "/balance-sheet", "/cash-flow"]) revalidatePath(p)
  return { ok: true }
}
const date = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UserInputError("Choose a date.")
  return new Date(`${v}T00:00:00Z`)
}
const percent = (v: string, label: string, optional = false) => {
  const n = normalizeNumber(v)
  if (n === "" && optional) return null
  if (!n) throw new UserInputError(`${label}: enter a percentage.`)
  return new Decimal(n).div(100)
}

export async function saveOwnerAction(input: { id: string | null; name: string; type: string; email: string; ownership: string; profit: string; from: string }): Promise<Result> {
  try {
    const user = await authorize("ownership:manage")
    const id = await saveOwner(user, { id: input.id, name: input.name, type: input.type === "COMPANY" ? "COMPANY" : "INDIVIDUAL", email: input.email.trim() || null })
    if (input.ownership.trim()) {
      await setStake(user, id, { ownershipShare: percent(input.ownership, "Ownership")!, profitShare: percent(input.profit, "Profit share", true), validFrom: date(input.from) })
    }
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function createDistributionAction(input: { date: string; basis: string; payout: string; notes: string }): Promise<Result> {
  try {
    const user = await authorize("distribution:manage")
    const basis = normalizeNumber(input.basis)
    if (!basis) throw new UserInputError("Enter the distributable profit.")
    await createDistribution(user, { declaredDate: date(input.date), basisAmount: new Decimal(basis), payoutRate: percent(input.payout || "100", "Payout")!, notes: input.notes.trim() || null })
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function approveDistributionAction(id: string): Promise<Result> {
  try {
    await approveDistribution(await authorize("distribution:approve"), id)
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function cancelDistributionAction(id: string): Promise<Result> {
  try {
    await cancelDistribution(await authorize("distribution:manage"), id)
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function payAllocationAction(id: string, input: { accountId: string; date: string; reference: string }): Promise<Result> {
  try {
    await payAllocation(await authorize("distribution:manage"), id, { financialAccountId: input.accountId, date: date(input.date), reference: input.reference.trim() || null })
    return done()
  } catch (e) {
    return fail(e)
  }
}
