import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { UserInputError } from "@/lib/forms"

import type { ToolEvent } from "./chat"

/** A user's AI CFO conversations, newest first. Only the user's own, in their organization. */
export async function listConversations(user: SessionUser, db: Db = prisma) {
  const rows = await db.aiConversation.findMany({
    where: { organizationId: user.organizationId, userId: user.id, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  })
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }))
}

export type StoredMessage = {
  id: string
  role: "USER" | "ASSISTANT"
  status: "COMPLETE" | "TRUNCATED" | "REFUSED" | "ERROR"
  content: string
  tools: ToolEvent[]
  followUps: string[]
  createdAt: string
}

export async function loadConversation(user: SessionUser, id: string, db: Db = prisma) {
  const c = await db.aiConversation.findFirst({
    where: { id, organizationId: user.organizationId, userId: user.id, archivedAt: null },
    include: { messages: { orderBy: { createdAt: "asc" }, take: 200 } },
  })
  if (!c) throw new UserInputError("Conversation not found.")
  const context = (c.context ?? {}) as { period?: string | null; departmentId?: string | null; focus?: string | null }
  return {
    id: c.id,
    title: c.title,
    context: { period: context.period ?? null, departmentId: context.departmentId ?? null, focus: context.focus ?? null },
    messages: c.messages.map(
      (m): StoredMessage => ({
        id: m.id,
        role: m.role,
        status: m.status,
        content: m.content,
        tools: Array.isArray(m.tools) ? (m.tools as unknown as ToolEvent[]) : [],
        followUps: Array.isArray(m.followUps) ? (m.followUps as string[]) : [],
        createdAt: m.createdAt.toISOString(),
      }),
    ),
  }
}

/** Hides a conversation from the list (history is kept: messages are append-only). */
export async function archiveConversation(user: SessionUser, id: string, db: Db = prisma) {
  const { count } = await db.aiConversation.updateMany({ where: { id, organizationId: user.organizationId, userId: user.id, archivedAt: null }, data: { archivedAt: new Date() } })
  if (!count) throw new UserInputError("Conversation not found.")
  await db.auditLog.create({ data: { organizationId: user.organizationId, actorType: "USER", actorUserId: user.id, action: "ai_cfo.archive", entityType: "ai_conversation", entityId: id } })
}

/** AI usage this month for the organization (for the limits panel). */
export async function monthlyUsage(user: SessionUser, db: Db = prisma, now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const [row] = await db.$queryRaw<{ org_usd: string; user_usd: string; answers: number }[]>`
    SELECT coalesce(sum(cost_usd), 0)::text AS org_usd,
           coalesce(sum(cost_usd) FILTER (WHERE user_id = ${user.id}::uuid), 0)::text AS user_usd,
           count(*) FILTER (WHERE role = 'ASSISTANT')::int AS answers
    FROM ai_messages WHERE organization_id = ${user.organizationId}::uuid AND created_at >= ${monthStart}`
  return { orgUsd: Number(row.org_usd), userUsd: Number(row.user_usd), answers: row.answers }
}
