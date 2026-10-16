"use server"

import { revalidatePath } from "next/cache"

import { authorize } from "@/lib/auth/session"
import { ACCOUNT_TYPES, createFinancialAccount } from "@/lib/data/accounts"
import { oneOf, requiredText, text, toActionError, type ActionState } from "@/lib/forms"
import { SUPPORTED_CURRENCIES } from "@/lib/money"

export async function createAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("ledger:manage")
    await createFinancialAccount(user, {
      name: requiredText(formData, "name", 120),
      type: oneOf(formData, "type", ACCOUNT_TYPES),
      currency: oneOf(formData, "currency", SUPPORTED_CURRENCIES),
      institution: text(formData, "institution", { max: 120 }),
    })
    revalidatePath("/accounts")
    revalidatePath("/payroll")
    return { status: "success", message: "✓" }
  } catch (error) {
    return toActionError(error)
  }
}
