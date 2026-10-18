/**
 * CSV/XLSX transaction import end to end on a throwaway PGlite database (never Supabase): upload,
 * mapping, validation, confirmation into drafts, duplicates, repeated imports, permissions,
 * organization isolation, and recovery from a failed database write. All data is fictional.
 * Usage: npm run test:import
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54333)
  const { step, summary } = stepRunner()
  const imports = await import("../src/lib/data/imports")
  const { createFinancialAccount } = await import("../src/lib/data/accounts")
  const { writeXlsx } = await import("../src/lib/xlsx")
  const { ImportFileError } = await import("../src/lib/imports/parse")
  type Perm = import("../src/lib/authz/permissions").Permission

  const utf8 = (s: string) => new TextEncoder().encode(s)
  const upload = (name: string, text: string | Uint8Array, user = admin) => imports.createImportBatch(user, { name, bytes: typeof text === "string" ? utf8(text) : text }, {}, prisma)
  const counts = async () => ({
    transactions: await prisma.transaction.count(),
    drafts: await prisma.transaction.count({ where: { status: "DRAFT" } }),
    journal: await prisma.journalEntry.count(),
  })

  try {
    await createFinancialAccount(admin, { name: "Bank USD", type: "BANK", currency: "USD", institution: null }, prisma)
    await prisma.shareholder.create({ data: { organizationId: org.id, type: "INDIVIDUAL", name: "Owner Test" } })
    const dept = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })

    const csv = [
      "Дата;Описание;Сумма;Валюта;Тип;Счёт;Категория;Отдел;Контрагент",
      `01.10.2026;Оплата по договору;1 500,00;USD;Выручка;Bank USD;INFLUENCER-REVENUE;${dept.name};`,
      "02.10.2026;Подписка;-120,50;USD;Операционный расход;Bank USD;SOFTWARE;;",
      "03.10.2026;Взнос владельца;10 000,00;USD;Взнос собственника;Bank USD;;;Owner Test",
      "04.10.2026;Ошибка категории;10,00;USD;Выручка;Bank USD;SOFTWARE;;",
      "02.10.2026;Подписка;-120,50;USD;Операционный расход;Bank USD;SOFTWARE;;",
      ";Без даты;5,00;USD;Операционный расход;Bank USD;SOFTWARE;;",
    ].join("\r\n")

    let batchId = ""
    let settings: Awaited<ReturnType<typeof upload>>["settings"]
    await step("upload: CSV is read on the server, stored as a batch, nothing is created yet", async () => {
      const before = await counts()
      const u = await upload("bank.csv", csv)
      assert.equal(u.format, "CSV")
      assert.equal(u.delimiter, ";")
      assert.equal(u.rowCount, 7)
      assert.deepEqual(u.settings.mapping, { date: 0, description: 1, amount: 2, currency: 3, type: 4, account: 5, category: 6, department: 7, counterparty: 8 })
      batchId = u.batchId
      settings = u.settings
      assert.deepEqual(await counts(), before)
      assert.equal(await prisma.auditLog.count({ where: { action: "transaction_import.upload" } }), 1)
    })

    await step("validation: every row checked, errors with file row numbers, duplicates and totals", async () => {
      const v = await imports.validateImportBatch(admin, batchId, settings, prisma)
      assert.deepEqual(v.missing, [])
      assert.deepEqual(v.rows.map((r) => [r.row, r.status]), [[2, "ok"], [3, "warning"], [4, "ok"], [5, "error"], [6, "duplicate"], [7, "error"]])
      assert.deepEqual(v.rows.find((r) => r.row === 5)!.issues.map((i) => i.code), ["category_kind"])
      assert.deepEqual(v.rows.find((r) => r.row === 7)!.issues.map((i) => i.code), ["date_required"])
      assert.deepEqual(v.summary.totals, [{ currency: "USD", income: "1500", expense: "120.5", other: "10000", count: 3 }])
      assert.equal(v.summary.errors, 2)
    })

    await step("missing required columns are reported before any row is checked", async () => {
      const v = await imports.validateImportBatch(admin, batchId, { ...settings, mapping: { description: 1, currency: 3 } }, prisma)
      assert.deepEqual(v.missing, ["date", "amount", "type"])
      assert.deepEqual(v.rows, [])
      await assert.rejects(() => imports.validateImportBatch(admin, batchId, { ...settings, mapping: { date: 999 } }, prisma), /Invalid import settings/)
    })

    await step("confirmation creates drafts only (no ledger postings), linked to the batch, excluded rows skipped", async () => {
      const before = await counts()
      const r = await imports.commitImportBatch(admin, batchId, settings, [2, 3, 4, 5, 7], prisma)
      assert.equal(r.status, "IMPORTED")
      assert.deepEqual([r.created, r.duplicates, r.excluded, r.failed], [3, 0, 3, 0])
      const after = await counts()
      assert.equal(after.transactions - before.transactions, 3)
      assert.equal(after.drafts - before.drafts, 3)
      assert.equal(after.journal, before.journal, "nothing is posted to the ledger")
      const created = await prisma.transaction.findMany({ where: { importBatchId: batchId }, orderBy: { number: "asc" } })
      assert.deepEqual(created.map((t) => [t.type, t.amount.toString(), t.status]), [["REVENUE", "1500", "DRAFT"], ["OPERATING_EXPENSE", "120.5", "DRAFT"], ["OWNER_CONTRIBUTION", "10000", "DRAFT"]])
      assert.ok(created.every((t) => t.externalRef))
      assert.equal(created[0].departmentId, dept.id)
      const batch = await prisma.transactionImportBatch.findUniqueOrThrow({ where: { id: batchId } })
      assert.equal(batch.status, "IMPORTED")
      assert.equal(batch.createdCount, 3)
      // Confirming the same batch again changes nothing.
      const again = await imports.commitImportBatch(admin, batchId, settings, [2, 3, 4], prisma)
      assert.equal(again.created, 3)
      assert.equal((await counts()).transactions, after.transactions)
    })

    await step("repeated import of the same file: every row is recognised as already imported", async () => {
      const u = await upload("bank.csv", csv)
      assert.equal(u.previousImports.length, 1)
      const v = await imports.validateImportBatch(admin, u.batchId, u.settings, prisma)
      assert.deepEqual(v.rows.filter((r) => r.issues.some((i) => i.code === "already_imported")).map((r) => r.row), [2, 3, 4])
      const before = await counts()
      const r = await imports.commitImportBatch(admin, u.batchId, u.settings, [2, 3, 4], prisma)
      assert.deepEqual([r.created, r.duplicates], [0, 3])
      assert.deepEqual(await counts(), before)
    })

    await step("XLSX: stored values, Excel serial dates, US dates and dot decimals", async () => {
      const book = writeXlsx([
        ["Date", "Description", "Amount", "Type", "Account", "Category"],
        [46300, "Excel date", "2,500.75", "Revenue", "Bank USD", "INFLUENCER-REVENUE"],
        ["10/07/2026", "US date", "99.99", "Operating expense", "Bank USD", "SOFTWARE"],
      ])
      const u = await upload("book.xlsx", book)
      assert.equal(u.format, "XLSX")
      const v = await imports.validateImportBatch(admin, u.batchId, { ...u.settings, dateFormat: "MDY" }, prisma)
      assert.deepEqual(v.rows.map((r) => [r.preview?.date, r.preview?.amount, r.status]), [["2026-10-05", "2500.75", "ok"], ["2026-10-07", "99.99", "ok"]])
      const r = await imports.commitImportBatch(admin, u.batchId, { ...u.settings, dateFormat: "MDY" }, [2, 3], prisma)
      assert.equal(r.created, 2)
    })

    await step("incorrect files are rejected with a reason", async () => {
      await assert.rejects(() => upload("report.pdf", "%PDF-1.4"), (e) => e instanceof ImportFileError && e.code === "unsupported")
      await assert.rejects(() => upload("old.xls", "binary"), (e) => e instanceof ImportFileError && e.code === "legacy_xls")
      await assert.rejects(() => upload("fake.xlsx", "date,amount"), (e) => e instanceof ImportFileError && e.code === "corrupt")
      await assert.rejects(() => upload("empty.csv", ""), (e) => e instanceof ImportFileError && e.code === "empty")
    })

    await step("permissions: importing needs journal:create; other organizations cannot see the batch", async () => {
      const readOnlyId = randomUUID()
      await prisma.appUser.create({ data: { id: readOnlyId, email: "ro-import@example.test", status: "ACTIVE" } })
      const role = await prisma.role.findFirstOrThrow({ where: { organizationId: org.id, key: "READ_ONLY" } })
      await prisma.userRoleAssignment.create({ data: { organizationId: org.id, userId: readOnlyId, roleId: role.id } })
      const rows = await prisma.$queryRaw<{ key: string }[]>`SELECT "key" FROM "permissions" WHERE "finance_private"."user_has_permission"(${readOnlyId}::uuid, ${org.id}::uuid, "key")`
      const readOnly = { ...admin, id: readOnlyId, isSuperAdmin: false, permissions: new Set(rows.map((r) => r.key as Perm)) }
      assert.equal(readOnly.permissions.has("journal:create"), false)
      await assert.rejects(() => upload("bank.csv", csv, readOnly), /permission/)
      await assert.rejects(() => imports.validateImportBatch(readOnly, batchId, settings, prisma), /permission/)
      await assert.rejects(() => imports.commitImportBatch(readOnly, batchId, settings, [2], prisma), /permission/)
      const other = await prisma.organization.create({ data: { name: "Other Org", baseCurrency: "USD" } })
      const outsider = { ...admin, organizationId: other.id }
      await assert.rejects(() => imports.validateImportBatch(outsider, batchId, settings, prisma), /Import not found/)
      assert.deepEqual(await imports.listImportBatches(outsider, prisma), [])
      assert.ok((await imports.listImportBatches(admin, prisma)).length >= 3)
    })

    await step("a failed database write leaves no partial chunk, other rows are kept, and a retry resumes without duplicates", async () => {
      const file = ["date,description,amount,type,account,category", "2026-10-20,Good one,10,expense,Bank USD,SOFTWARE", "2026-10-21,FAIL ME,11,expense,Bank USD,SOFTWARE", "2026-10-22,Good two,12,expense,Bank USD,SOFTWARE"].join("\n")
      const u = await upload("flaky.csv", file)
      // A client whose writes fail for one row (simulates a database error during the import).
      // Nested transactions (the service's own) get the same failing client.
      type Client = typeof prisma
      const wrapTx = (tx: Client): Client =>
        new Proxy(tx, {
          get(t, p) {
            if (p === "$transaction") return (fn: (inner: Client) => Promise<unknown>) => fn(wrapTx(t))
            if (p !== "transaction") return Reflect.get(t, p)
            return new Proxy(t.transaction, {
              get(model, q) {
                if (q !== "create") return Reflect.get(model, q)
                return async (args: Parameters<typeof model.create>[0]) => {
                  if ((args.data as { description?: string }).description === "FAIL ME") throw new Error("simulated write failure")
                  return model.create(args)
                }
              },
            })
          },
        })
      const failing = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop !== "$transaction") return Reflect.get(target, prop, receiver)
          return (fn: (tx: Client) => Promise<unknown>, options: object) => target.$transaction((tx) => fn(wrapTx(tx as unknown as Client)), options)
        },
      }) as Client
      const before = await prisma.transaction.count()
      const r = await imports.commitImportBatch(admin, u.batchId, u.settings, [2, 3, 4], failing)
      assert.equal(r.status, "PARTIAL")
      assert.deepEqual(r.outcomes.map((o) => [o.row, o.outcome]), [[2, "created"], [3, "failed"], [4, "created"]])
      assert.equal(r.outcomes[1].message, "The database rejected the row.")
      assert.equal(await prisma.transaction.count(), before + 2)
      const retry = await imports.commitImportBatch(admin, u.batchId, u.settings, [2, 3, 4], prisma)
      assert.equal(retry.status, "IMPORTED")
      assert.deepEqual([retry.created, retry.duplicates], [1, 2])
      assert.equal(await prisma.transaction.count(), before + 3)
      assert.equal((await prisma.transactionImportBatch.findUniqueOrThrow({ where: { id: u.batchId } })).createdCount, 3)
    })

    await step("a cancelled import cannot be confirmed; imported batches cannot be cancelled", async () => {
      const u = await upload("cancel.csv", "date,description,amount,type,account,category\n2026-10-25,X,1,expense,Bank USD,SOFTWARE")
      await imports.cancelImportBatch(admin, u.batchId, prisma)
      await assert.rejects(() => imports.commitImportBatch(admin, u.batchId, u.settings, [2], prisma), /cancelled/)
      await assert.rejects(() => imports.cancelImportBatch(admin, batchId, prisma), /not been confirmed/)
    })
  } finally {
    summary()
    await stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
