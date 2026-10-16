import "server-only"

import type { PrismaClient } from "@/generated/prisma/client"
import { prisma } from "@/lib/db"

import type { Tx } from "./common"

export type Db = PrismaClient | Tx

/** Runs fn in a transaction; reuses the caller's transaction when given one (used by tests). */
export function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return "$transaction" in db ? db.$transaction(fn, { timeout: 20_000 }) : fn(db)
}

export { prisma }
