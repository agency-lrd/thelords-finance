-- Indexes for frequent report and register filters. Additive only.
CREATE INDEX IF NOT EXISTS "journal_lines_client_id_idx" ON "journal_lines"("client_id");
CREATE INDEX IF NOT EXISTS "transactions_department_id_idx" ON "transactions"("department_id");
CREATE INDEX IF NOT EXISTS "transactions_category_id_idx" ON "transactions"("category_id");
CREATE INDEX IF NOT EXISTS "transactions_organization_id_status_date_idx" ON "transactions"("organization_id", "status", "date");
