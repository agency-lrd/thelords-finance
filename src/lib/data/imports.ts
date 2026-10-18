import "server-only"

import { createHash } from "node:crypto"

import { z } from "zod"

import type { Prisma, TransactionType } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { IMPORT_FIELDS, LIMITS, type ImportSettings, type ImportSummary, type RowCheck } from "@/lib/imports/fields"
import { readImportFile } from "@/lib/imports/parse"
import { defaultSettings } from "@/lib/imports/mapping"
import { missingMapping, summarize, validateRows, type Lookups, type ValidatedRow } from "@/lib/imports/rows"
import { Decimal } from "@/lib/money"

import { audit } from "./common"
import { prisma, type Db } from "./db"
import { createTransaction, transactionOptions } from "./transactions"

/*
 * CSV/XLSX import of transactions as drafts.
 *  1. upload: the file is read safely, its cells stored in a batch (nothing is created yet);
 *  2. validate: with the chosen mapping and formats, every row is checked against the same rules as the
 *     transaction form and against existing transactions (duplicates);
 *  3. confirm: the rows the user kept are created as drafts, never posted, through createTransaction,
 *     in chunks; each row carries a stable import key, so a repeated or resumed import never duplicates.
 * Every step requires journal:create and is scoped to the user's organization.
 */

const need = (user: SessionUser) => {
  if (!user.permissions.has("journal:create")) throw new UserInputError("You do not have permission to import transactions.")
}

export const SettingsSchema = z.strictObject({
  headerRow: z.number().int().min(0).max(50),
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(LIMITS.maxColumns - 1).nullable()),
  dateFormat: z.enum(["auto", "DMY", "MDY", "YMD"]),
  decimal: z.enum(["auto", ".", ","]),
  defaults: z.strictObject({
    type: z.string().max(40).nullable(),
    currency: z.string().max(10).nullable(),
    account: z.string().max(100).nullable(),
    category: z.string().max(100).nullable(),
  }),
})

function parseSettings(raw: unknown): ImportSettings {
  const parsed = SettingsSchema.safeParse(raw)
  if (!parsed.success) throw new UserInputError("Invalid import settings.")
  const mapping: ImportSettings["mapping"] = {}
  for (const [k, v] of Object.entries(parsed.data.mapping)) if (v !== null && v !== undefined) mapping[k as keyof typeof mapping] = v
  return { ...parsed.data, mapping }
}

async function batchOf(user: SessionUser, id: string, db: Db) {
  const batch = await db.transactionImportBatch.findFirst({ where: { id, organizationId: user.organizationId } })
  if (!batch) throw new UserInputError("Import not found.")
  return batch
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function createImportBatch(user: SessionUser, file: { name: string; bytes: Uint8Array }, options: { delimiter?: string | null; encoding?: string | null } = {}, db: Db = prisma) {
  need(user)
  const parsed = readImportFile(file.name, file.bytes, options)
  const sha = createHash("sha256").update(file.bytes).digest("hex")
  const previous = await db.transactionImportBatch.findMany({
    where: { organizationId: user.organizationId, fileSha256: sha, status: { in: ["IMPORTED", "PARTIAL"] } },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { id: true, createdAt: true, createdCount: true, status: true },
  })
  const batch = await db.transactionImportBatch.create({
    data: {
      organizationId: user.organizationId,
      createdById: user.id,
      fileName: file.name.slice(0, 255) || "import",
      fileSize: file.bytes.length,
      fileSha256: sha,
      format: parsed.format,
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      rowCount: parsed.rows.length,
      cells: parsed.rows,
    },
  })
  await audit(db as Prisma.TransactionClient, user, "transaction_import.upload", "transaction_import_batch", batch.id, { file: batch.fileName, rows: parsed.rows.length, format: parsed.format })
  return {
    batchId: batch.id,
    fileName: batch.fileName,
    format: parsed.format,
    encoding: parsed.encoding,
    delimiter: parsed.delimiter,
    rowCount: parsed.rows.length,
    sample: parsed.rows.slice(0, 40),
    columns: Math.max(...parsed.rows.slice(0, 200).map((r) => r.length)),
    settings: defaultSettings(parsed.rows),
    previousImports: previous.map((p) => ({ id: p.id, at: p.createdAt.toISOString(), created: p.createdCount, status: p.status })),
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function lookups(user: SessionUser, rows: string[][], settings: ImportSettings, db: Db): Promise<Lookups> {
  const options = await transactionOptions(user, db)
  const periods = await db.financialPeriod.findMany({ where: { organizationId: user.organizationId, status: { in: ["CLOSED", "LOCKED"] } }, select: { year: true, month: true } })
  const rates = await db.exchangeRate.findMany({ where: { organizationId: user.organizationId, quoteCurrency: user.baseCurrency }, select: { baseCurrency: true, rateDate: true } })
  const base: Lookups = {
    baseCurrency: user.baseCurrency,
    currencies: ["USD", "EUR", "GBP", "USDT"],
    accounts: options.accounts,
    categories: options.categories,
    departments: options.departments,
    clients: options.clients,
    projects: options.projects,
    owners: options.shareholders,
    closedMonths: new Set(periods.map((p) => `${p.year}-${String(p.month).padStart(2, "0")}`)),
    // Same rule as the transaction service: the rate dated on the last day of the month.
    fxMonths: new Set(rates.filter((r) => new Date(r.rateDate.getTime() + 86_400_000).getUTCDate() === 1).map((r) => `${r.baseCurrency}|${r.rateDate.toISOString().slice(0, 7)}`)),
    existingKeys: new Set(),
    existingFingerprints: new Set(),
  }
  // First pass gives the keys and dates; then look up what already exists.
  const first = validateRows(rows, settings, base)
  const keys = first.map((r) => r.key).filter((k): k is string => !!k)
  for (let i = 0; i < keys.length; i += 1000) {
    const hits = await db.transaction.findMany({ where: { organizationId: user.organizationId, externalRef: { in: keys.slice(i, i + 1000) } }, select: { externalRef: true } })
    for (const h of hits) if (h.externalRef) base.existingKeys.add(h.externalRef)
  }
  const dates = first.map((r) => r.preview?.date).filter((d): d is string => !!d).sort()
  if (dates.length) {
    const existing = await db.transaction.findMany({
      where: { organizationId: user.organizationId, status: { not: "REVERSED" }, date: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[dates.length - 1]}T00:00:00Z`) } },
      select: { date: true, type: true, amount: true, currency: true },
      take: 20000,
    })
    for (const t of existing) base.existingFingerprints.add(`${t.date.toISOString().slice(0, 10)}|${t.type}|${new Decimal(t.amount.toString()).toString()}|${t.currency}`)
  }
  return base
}

async function validateBatch(user: SessionUser, batch: { cells: unknown }, settings: ImportSettings, db: Db) {
  const rows = batch.cells as string[][]
  const missing = missingMapping(settings)
  if (missing.length) return { missing, rows: [] as ValidatedRow[] }
  return { missing, rows: validateRows(rows, settings, await lookups(user, rows, settings, db)) }
}

const publicRow = (r: ValidatedRow): RowCheck => ({ row: r.row, status: r.status, include: r.include, issues: r.issues, preview: r.preview })

export async function validateImportBatch(user: SessionUser, batchId: string, rawSettings: unknown, db: Db = prisma): Promise<{ missing: string[]; rows: RowCheck[]; summary: ImportSummary }> {
  need(user)
  const settings = parseSettings(rawSettings)
  const batch = await batchOf(user, batchId, db)
  if (batch.status === "CANCELLED") throw new UserInputError("This import was cancelled.")
  const { missing, rows } = await validateBatch(user, batch, settings, db)
  await db.transactionImportBatch.update({ where: { id: batch.id }, data: { settings: settings as unknown as Prisma.InputJsonValue } })
  return { missing, rows: rows.map(publicRow), summary: summarize(rows, (r) => r.include) }
}

// ─── Confirmation ────────────────────────────────────────────────────────────

export type RowOutcome = { row: number; outcome: "created" | "already_imported" | "excluded" | "invalid" | "failed"; number?: number; message?: string }

export type ImportResult = {
  batchId: string
  status: "IMPORTED" | "PARTIAL" | "FAILED"
  created: number
  duplicates: number
  excluded: number
  failed: number
  outcomes: RowOutcome[]
}

const toInput = (r: NonNullable<ValidatedRow["input"]>, batchId: string) => ({
  type: r.type as TransactionType,
  date: new Date(`${r.date}T00:00:00Z`),
  description: r.description,
  amount: new Decimal(r.amount),
  currency: r.currency,
  fxRate: r.fxRate ? new Decimal(r.fxRate) : null,
  fee: null,
  financialAccountId: r.financialAccountId,
  counterFinancialAccountId: r.counterFinancialAccountId,
  categoryId: r.categoryId,
  debitAccountId: null,
  creditAccountId: null,
  departmentId: r.departmentId,
  clientId: r.clientId,
  projectId: r.projectId,
  shareholderId: r.shareholderId,
  counterparty: r.counterparty,
  direction: null,
  settlementStatus: r.settlementStatus,
  dueDate: r.dueDate ? new Date(`${r.dueDate}T00:00:00Z`) : null,
  notes: r.notes,
  attachmentUrl: null,
  externalRef: r.key,
  importBatchId: batchId,
})

const errorText = (e: unknown) => (e instanceof UserInputError ? e.message : "The database rejected the row.")

/**
 * Creates the chosen rows as drafts. Rows are revalidated on the server; only valid rows the user kept
 * are written. Each chunk is one database transaction; if a chunk fails, its rows are retried one by
 * one so a single bad row cannot block the others. Confirming again (after a failure) resumes: rows
 * already created are recognised by their import key and skipped.
 */
export async function commitImportBatch(user: SessionUser, batchId: string, rawSettings: unknown, includeRows: number[], db: Db = prisma): Promise<ImportResult> {
  need(user)
  if (!("$transaction" in db)) throw new Error("commitImportBatch needs the database client, not a transaction.")
  const settings = parseSettings(rawSettings)
  if (!Array.isArray(includeRows) || includeRows.length > LIMITS.maxRows || includeRows.some((n) => !Number.isInteger(n))) throw new UserInputError("Invalid row selection.")
  const batch = await batchOf(user, batchId, db)
  if (batch.status === "IMPORTED") return batch.result as unknown as ImportResult
  if (batch.status === "CANCELLED") throw new UserInputError("This import was cancelled.")
  // Only one confirmation at a time per batch.
  const { count } = await db.transactionImportBatch.updateMany({ where: { id: batch.id, status: { in: ["PARSED", "PARTIAL", "FAILED"] } }, data: { status: "IMPORTING" } })
  if (!count) throw new UserInputError("This import is already running.")

  try {
    const { missing, rows } = await validateBatch(user, batch, settings, db)
    if (missing.length) throw new UserInputError("Map the required columns first.")
    const wanted = new Set(includeRows)
    const outcomes = new Map<number, RowOutcome>()
    const toCreate: ValidatedRow[] = []
    for (const r of rows) {
      if (!wanted.has(r.row)) outcomes.set(r.row, { row: r.row, outcome: "excluded" })
      else if (r.issues.some((i) => i.code === "already_imported")) outcomes.set(r.row, { row: r.row, outcome: "already_imported" })
      else if (!r.input) outcomes.set(r.row, { row: r.row, outcome: "invalid" })
      else toCreate.push(r)
    }

    const write = async (chunk: ValidatedRow[]) =>
      db.$transaction(
        async (tx) => {
          const existing = new Set((await tx.transaction.findMany({ where: { organizationId: user.organizationId, externalRef: { in: chunk.map((r) => r.input!.key) } }, select: { externalRef: true } })).map((t) => t.externalRef))
          const done: RowOutcome[] = []
          for (const r of chunk) {
            if (existing.has(r.input!.key)) done.push({ row: r.row, outcome: "already_imported" })
            else {
              const created = await createTransaction(user, toInput(r.input!, batch.id), {}, tx)
              done.push({ row: r.row, outcome: "created", number: created.number })
            }
          }
          return done
        },
        { timeout: 120_000, maxWait: 15_000 },
      )

    for (let i = 0; i < toCreate.length; i += LIMITS.chunkSize) {
      const chunk = toCreate.slice(i, i + LIMITS.chunkSize)
      try {
        for (const o of await write(chunk)) outcomes.set(o.row, o)
      } catch {
        // Isolate the failing rows: retry this chunk row by row.
        for (const r of chunk) {
          try {
            for (const o of await write([r])) outcomes.set(o.row, o)
          } catch (e) {
            outcomes.set(r.row, { row: r.row, outcome: "failed", message: errorText(e) })
          }
        }
      }
    }

    const list = [...outcomes.values()].sort((a, b) => a.row - b.row)
    const n = (o: RowOutcome["outcome"]) => list.filter((x) => x.outcome === o).length
    const failed = n("failed")
    const status: ImportResult["status"] = failed === 0 ? "IMPORTED" : n("created") > 0 || list.some((x) => x.outcome === "already_imported") ? "PARTIAL" : "FAILED"
    const result: ImportResult = { batchId: batch.id, status, created: n("created"), duplicates: n("already_imported"), excluded: n("excluded") + n("invalid"), failed, outcomes: list }
    // A resumed import keeps the earlier created count.
    const before = batch.status === "PARTIAL" || batch.status === "FAILED" ? batch.createdCount : 0
    await db.transactionImportBatch.update({
      where: { id: batch.id },
      data: {
        status,
        settings: settings as unknown as Prisma.InputJsonValue,
        createdCount: before + result.created,
        duplicateCount: result.duplicates,
        excludedCount: result.excluded,
        errorCount: failed,
        result: result as unknown as Prisma.InputJsonValue,
        errorMessage: failed ? list.find((x) => x.outcome === "failed")?.message ?? null : null,
        completedAt: new Date(),
      },
    })
    await audit(db as Prisma.TransactionClient, user, "transaction_import.commit", "transaction_import_batch", batch.id, { status, created: result.created, duplicates: result.duplicates, excluded: result.excluded, failed })
    return result
  } catch (e) {
    await db.transactionImportBatch.update({ where: { id: batch.id }, data: { status: batch.status, errorMessage: errorText(e) } })
    throw e
  }
}

// ─── History ─────────────────────────────────────────────────────────────────

export async function listImportBatches(user: SessionUser, db: Db = prisma) {
  if (!user.permissions.has("journal:create") && !user.permissions.has("ledger:read")) throw new UserInputError("You do not have permission to view imports.")
  const rows = await db.transactionImportBatch.findMany({
    where: { organizationId: user.organizationId, status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, fileName: true, format: true, rowCount: true, status: true, createdCount: true, duplicateCount: true, excludedCount: true, errorCount: true, createdAt: true, completedAt: true, createdBy: { select: { email: true } } },
  })
  return rows.map((r) => ({ ...r, createdBy: r.createdBy.email, createdAt: r.createdAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null }))
}

export async function cancelImportBatch(user: SessionUser, batchId: string, db: Db = prisma) {
  need(user)
  const { count } = await db.transactionImportBatch.updateMany({ where: { id: batchId, organizationId: user.organizationId, status: "PARSED" }, data: { status: "CANCELLED" } })
  if (!count) throw new UserInputError("Only an import that has not been confirmed can be cancelled.")
}
