"use server"

import { revalidatePath } from "next/cache"

import { authorize } from "@/lib/auth/session"
import { toActionError, UserInputError } from "@/lib/forms"
import { normalizeNumber } from "@/lib/i18n/format"
import { Decimal } from "@/lib/money"
import { createCustomMetric, setOrganizationKpi } from "@/lib/reports/analytics"

type Result = { ok: true } | { ok: false; message: string }

export async function setKpiAction(code: string, year: number, month: number, raw: string): Promise<Result> {
  try {
    const user = await authorize("kpi:manage")
    const n = normalizeNumber(raw)
    if (n === null) throw new UserInputError("Enter a number.")
    await setOrganizationKpi(user, code, year, month, n === "" ? null : new Decimal(n))
    revalidatePath("/analytics")
    revalidatePath("/")
    return { ok: true }
  } catch (error) {
    return { ok: false, message: toActionError(error).message ?? "Error" }
  }
}

export async function addMetricAction(name: string, unit: string): Promise<Result> {
  try {
    const user = await authorize("kpi:manage")
    if (!["COUNT", "CURRENCY", "PERCENT", "RATIO"].includes(unit)) throw new UserInputError("Choose a unit.")
    await createCustomMetric(user, { name, unit: unit as "COUNT" })
    revalidatePath("/analytics")
    return { ok: true }
  } catch (error) {
    return { ok: false, message: toActionError(error).message ?? "Error" }
  }
}
