"use server"

import { revalidatePath } from "next/cache"

import { authorize } from "@/lib/auth/session"
import { createDepartmentNode, createTeam, updateDepartment, updateTeam } from "@/lib/data/departments"
import { oneOf, optionalId, requiredText, toActionError, type ActionState } from "@/lib/forms"

const CLASSES = ["COST_OF_SALES", "OPERATING_EXPENSE"] as const

function done(message: string): ActionState {
  revalidatePath("/departments")
  revalidatePath("/payroll")
  return { status: "success", message }
}

export async function createDepartmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("structure:manage")
    await createDepartmentNode(user, {
      name: requiredText(formData, "name", 120),
      parentId: optionalId(formData, "parentId"),
      costClassification: oneOf(formData, "costClassification", CLASSES),
    })
    return done("✓")
  } catch (error) {
    return toActionError(error)
  }
}

export async function updateDepartmentAction(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("structure:manage")
    await updateDepartment(user, id, {
      name: requiredText(formData, "name", 120),
      parentId: optionalId(formData, "parentId"),
      costClassification: oneOf(formData, "costClassification", CLASSES),
      headEmployeeId: optionalId(formData, "headEmployeeId"),
    })
    return done("✓")
  } catch (error) {
    return toActionError(error)
  }
}

export async function archiveDepartmentAction(id: string, archived: boolean, _prev: ActionState): Promise<ActionState> {
  void _prev
  try {
    const user = await authorize("structure:manage")
    await updateDepartment(user, id, { archived })
    return done("✓")
  } catch (error) {
    return toActionError(error)
  }
}

export async function createTeamAction(departmentId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("structure:manage")
    await createTeam(user, departmentId, { name: requiredText(formData, "name", 120), leadEmployeeId: optionalId(formData, "leadEmployeeId") })
    return done("✓")
  } catch (error) {
    return toActionError(error)
  }
}

export async function updateTeamAction(teamId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("structure:manage")
    await updateTeam(user, teamId, { leadEmployeeId: optionalId(formData, "leadEmployeeId"), archived: formData.get("archived") === "true" ? true : undefined })
    return done("✓")
  } catch (error) {
    return toActionError(error)
  }
}
