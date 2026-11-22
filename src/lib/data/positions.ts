import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Employee positions (job titles): a directory ordered explicitly, independent of departments (any
 * position can be used in any department). The order drives how employees are sorted inside a
 * department on the financial sheet. Positions are archived, never deleted, so history stays linked.
 */

export const DEFAULT_POSITIONS = [
  "Influencer Manager", "Searcher", "Team Lead", "Head of Influencer Marketing", "Crypto Influencer Manager",
  "BizDev Manager", "Sales Manager", "BizDev Team Lead", "Project Manager", "AI Creator", "Account Manager",
  "SMM Manager", "Creative Producer", "Scriptwriter", "Motion Designer", "Video Editor", "Graphic Designer",
  "Media Buyer", "Media Buying Team Lead", "Head of Traffic", "Financial Manager", "Accountant", "HR Manager",
  "Recruiter", "Operations Manager", "Data Analyst", "Developer", "QA Specialist", "Marketing Manager", "Head of Marketing",
] as const

function requireManage(user: SessionUser) {
  if (!user.permissions.has("employee:manage")) throw new UserInputError("You do not have permission to manage positions.")
}

const cleanName = (raw: string, label = "Position name") => {
  const name = (raw ?? "").trim().replace(/\s+/g, " ")
  if (!name || name.length > 80) throw new UserInputError(`${label}: 1 to 80 characters.`)
  return name
}

export type PositionRow = { id: string; name: string; nameRu: string | null; sortOrder: number; archived: boolean; employees: number; color: string | null }

/** #RRGGBB or null (default). */
export const normalizeColor = (raw: string | null | undefined) => {
  if (raw === null || raw === undefined || raw.trim() === "") return null
  const v = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`
  if (!/^#[0-9a-f]{6}$/i.test(v)) throw new UserInputError("Color must be a HEX value like #EC4899.")
  return v.toUpperCase()
}

/** The directory in its order. An organization without positions gets the defaults (idempotent). */
export async function listPositions(user: SessionUser, db: Db = prisma): Promise<PositionRow[]> {
  const org = user.organizationId
  if ((await db.position.count({ where: { organizationId: org } })) === 0) {
    await db.position.createMany({ data: DEFAULT_POSITIONS.map((name, i) => ({ organizationId: org, name, sortOrder: (i + 1) * 10 })), skipDuplicates: true })
  }
  const rows = await db.position.findMany({
    where: { organizationId: org },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { assignments: true } } },
  })
  return rows.map((p) => ({ id: p.id, name: p.name, nameRu: p.nameRu, sortOrder: p.sortOrder, archived: !!p.archivedAt, employees: p._count.assignments, color: p.color }))
}

export async function createPosition(user: SessionUser, input: { name: string; nameRu?: string | null }, db: Db = prisma) {
  requireManage(user)
  const name = cleanName(input.name)
  return inTx(db, async (tx) => {
    const clash = await tx.position.findFirst({ where: { organizationId: user.organizationId, name: { equals: name, mode: "insensitive" } } })
    if (clash) throw new UserInputError(clash.archivedAt ? "This position exists in the archive: restore it instead." : "A position with this name already exists.")
    const last = await tx.position.aggregate({ where: { organizationId: user.organizationId }, _max: { sortOrder: true } })
    const position = await tx.position.create({ data: { organizationId: user.organizationId, name, nameRu: input.nameRu?.trim() || null, sortOrder: (last._max.sortOrder ?? 0) + 10 } })
    await audit(tx, user, "position.create", "position", position.id, { name })
    return position
  })
}

export async function updatePosition(user: SessionUser, id: string, input: { name?: string; nameRu?: string | null; archived?: boolean; move?: "up" | "down"; color?: string | null }, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const position = await tx.position.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!position) throw new UserInputError("Position not found.")
    if (input.name !== undefined) {
      const name = cleanName(input.name)
      const clash = await tx.position.findFirst({ where: { organizationId: user.organizationId, id: { not: id }, name: { equals: name, mode: "insensitive" } } })
      if (clash) throw new UserInputError("A position with this name already exists.")
      await tx.position.update({ where: { id }, data: { name } })
    }
    if (input.nameRu !== undefined) await tx.position.update({ where: { id }, data: { nameRu: input.nameRu?.trim().slice(0, 80) || null } })
    if (input.archived !== undefined) await tx.position.update({ where: { id }, data: { archivedAt: input.archived ? new Date() : null } })
    // Purely visual: never touches employees, payroll or history.
    if (input.color !== undefined) await tx.position.update({ where: { id }, data: { color: normalizeColor(input.color) } })
    if (input.move) {
      const list = await tx.position.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } })
      const i = list.findIndex((p) => p.id === id)
      const j = input.move === "up" ? i - 1 : i + 1
      if (i >= 0 && j >= 0 && j < list.length) {
        const order = list.map((p) => p.id)
        ;[order[i], order[j]] = [order[j], order[i]]
        for (const [index, pid] of order.entries()) await tx.position.update({ where: { id: pid }, data: { sortOrder: (index + 1) * 10 } })
      }
    }
    await audit(tx, user, "position.update", "position", id, input)
  })
}
