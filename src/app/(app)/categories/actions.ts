"use server"

import { revalidatePath } from "next/cache"

import type { CategoryKind } from "@/generated/prisma/client"
import { authorize } from "@/lib/auth/session"
import { createCategory, KIND_SUBTYPE, updateCategory } from "@/lib/data/categories"
import { toActionError, UserInputError } from "@/lib/forms"

const UUID = /^[0-9a-f-]{36}$/i
type Result = { ok: true } | { ok: false; message: string }

function done(): Result {
  for (const p of ["/categories", "/transactions", "/payroll", "/pnl"]) revalidatePath(p)
  return { ok: true }
}

export async function createCategoryAction(input: { name: string; kind: string; parentId: string; ledgerAccountId: string }): Promise<Result> {
  try {
    const user = await authorize("ledger:manage")
    if (!(input.kind in KIND_SUBTYPE)) throw new UserInputError("Choose a category type.")
    await createCategory(user, {
      name: input.name,
      kind: input.kind as CategoryKind,
      parentId: UUID.test(input.parentId) ? input.parentId : null,
      ledgerAccountId: input.ledgerAccountId === "new" ? "new" : UUID.test(input.ledgerAccountId) ? input.ledgerAccountId : null,
    })
    return done()
  } catch (e) {
    return { ok: false, message: toActionError(e).message ?? "Error" }
  }
}

export async function updateCategoryAction(id: string, input: { name?: string; ledgerAccountId?: string; archived?: boolean }): Promise<Result> {
  try {
    const user = await authorize("ledger:manage")
    await updateCategory(user, id, { ...input, ledgerAccountId: input.ledgerAccountId && UUID.test(input.ledgerAccountId) ? input.ledgerAccountId : undefined })
    return done()
  } catch (e) {
    return { ok: false, message: toActionError(e).message ?? "Error" }
  }
}
