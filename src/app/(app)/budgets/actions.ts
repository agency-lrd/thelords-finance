"use server"

import { revalidatePath } from "next/cache"

import { authorize } from "@/lib/auth/session"
import { BUDGET_METRICS, SCENARIOS, setBudgetLine, type BudgetMetric } from "@/lib/data/budgets"
import { toActionError, UserInputError } from "@/lib/forms"
import { normalizeNumber } from "@/lib/i18n/format"
import { Decimal } from "@/lib/money"

const UUID = /^[0-9a-f-]{36}$/i

export async function setBudgetAction(input: { year: number; month: number; scenario: string; metric: string; departmentId: string; projectId: string; value: string }) {
  try {
    const user = await authorize("ledger:manage")
    if (!SCENARIOS.includes(input.scenario as (typeof SCENARIOS)[number])) throw new UserInputError("Unknown scenario.")
    if (!BUDGET_METRICS.includes(input.metric as BudgetMetric) || input.metric === "ACCOUNT") throw new UserInputError("Unknown metric.")
    const n = normalizeNumber(input.value)
    if (n === null) throw new UserInputError("Enter a number.")
    await setBudgetLine(user, {
      year: input.year,
      month: input.month,
      scenario: input.scenario as (typeof SCENARIOS)[number],
      metric: input.metric as BudgetMetric,
      ledgerAccountId: null,
      departmentId: UUID.test(input.departmentId) ? input.departmentId : null,
      projectId: UUID.test(input.projectId) ? input.projectId : null,
      amount: n === "" ? null : new Decimal(n),
    })
    for (const p of ["/budgets", "/", "/pnl", "/cash-flow"]) revalidatePath(p)
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, message: toActionError(error).message ?? "Error" }
  }
}
