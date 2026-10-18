-- CSV/XLSX import batches for transactions. Additive: a new table and a nullable link column on transactions.

-- CreateEnum
CREATE TYPE "import_batch_status" AS ENUM ('PARSED', 'IMPORTING', 'IMPORTED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "import_batch_id" UUID;

-- CreateTable
CREATE TABLE "transaction_import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "format" VARCHAR(4) NOT NULL,
    "encoding" VARCHAR(20),
    "delimiter" VARCHAR(5),
    "row_count" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,
    "settings" JSONB,
    "status" "import_batch_status" NOT NULL DEFAULT 'PARSED',
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "excluded_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "transaction_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transaction_import_batches_organization_id_created_at_idx" ON "transaction_import_batches"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "transaction_import_batches_organization_id_file_sha256_idx" ON "transaction_import_batches"("organization_id", "file_sha256");

-- CreateIndex
CREATE INDEX "transactions_import_batch_id_idx" ON "transactions"("import_batch_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "transaction_import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_import_batches" ADD CONSTRAINT "transaction_import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_import_batches" ADD CONSTRAINT "transaction_import_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "transaction_import_batches"
  ADD CONSTRAINT "transaction_import_batches_format_chk" CHECK ("format" IN ('CSV', 'XLSX')),
  ADD CONSTRAINT "transaction_import_batches_counts_chk" CHECK ("row_count" >= 0 AND "file_size" >= 0 AND "created_count" >= 0 AND "duplicate_count" >= 0 AND "excluded_count" >= 0 AND "error_count" >= 0),
  ADD CONSTRAINT "transaction_import_batches_name_chk" CHECK (length("file_name") BETWEEN 1 AND 255);

-- Import history is kept: batches cannot be deleted.
CREATE TRIGGER "transaction_import_batches_no_delete" BEFORE DELETE ON "transaction_import_batches"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();

ALTER TABLE "transaction_import_batches" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "transaction_import_batches" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "transaction_import_batches_read" ON "transaction_import_batches" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'ledger:read'));
