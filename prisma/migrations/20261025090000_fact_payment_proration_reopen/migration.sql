-- FACT PAYMENT overrides, prorated FIX settings and audited payroll re-opening. Additive only.

-- The final amount the owner intends to pay for an employee-month (null = the calculated salary).
ALTER TABLE "payroll_month_employees" ADD COLUMN "fact_payment" NUMERIC(20, 2);
ALTER TABLE "payroll_month_employees" ADD COLUMN "fact_reason" TEXT;
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_fact_payment_check" CHECK ("fact_payment" IS NULL OR "fact_payment" >= 0);

-- Prorated FIX: payable days are counted on a fixed monthly divisor (30 by default) and the start
-- day is paid by default. Both are explicit organization settings.
ALTER TABLE "organizations" ADD COLUMN "payroll_day_divisor" SMALLINT NOT NULL DEFAULT 30;
ALTER TABLE "organizations" ADD COLUMN "payroll_start_day_paid" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_payroll_day_divisor_check" CHECK ("payroll_day_divisor" BETWEEN 28 AND 31);

-- Every approval that was later re-opened, with what it contained. Append-only.
CREATE TABLE "payroll_approval_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "payroll_run_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "reopened_by_id" UUID NOT NULL,
    "reopened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "previous_status" TEXT NOT NULL,
    "journal_entry_id" UUID,
    "reversal_entry_id" UUID,
    "content" JSONB NOT NULL,

    CONSTRAINT "payroll_approval_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payroll_approval_versions_payroll_run_id_version_key" ON "payroll_approval_versions"("payroll_run_id", "version");
CREATE INDEX "payroll_approval_versions_period_id_idx" ON "payroll_approval_versions"("period_id");
ALTER TABLE "payroll_approval_versions" ADD CONSTRAINT "payroll_approval_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_approval_versions" ADD CONSTRAINT "payroll_approval_versions_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_approval_versions" ADD CONSTRAINT "payroll_approval_versions_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_approval_versions" ADD CONSTRAINT "payroll_approval_versions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_approval_versions" ADD CONSTRAINT "payroll_approval_versions_reopened_by_id_fkey" FOREIGN KEY ("reopened_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "payroll_approval_versions_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payroll_approval_versions is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "payroll_approval_versions_append_only" BEFORE UPDATE OR DELETE ON "payroll_approval_versions"
  FOR EACH ROW EXECUTE FUNCTION "payroll_approval_versions_append_only"();

ALTER TABLE "payroll_approval_versions" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "payroll_approval_versions" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "payroll_approval_versions_read" ON "payroll_approval_versions" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'payroll:read'));

-- Approved snapshots stay immutable. The single exception is re-opening an approval: inside that
-- transaction (flag finance.payroll_reopen = 'on'), a snapshot may be cleared, and only cleared, after
-- it has been copied to payroll_approval_versions.
CREATE OR REPLACE FUNCTION "payroll_month_employee_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."snapshot" IS NOT NULL THEN
    IF NOT (
      TG_OP = 'UPDATE'
      AND coalesce(current_setting('finance.payroll_reopen', true), '') = 'on'
      AND NEW."snapshot" IS NULL AND NEW."snapshot_at" IS NULL
      AND NEW."source" = OLD."source"
      AND NEW."fact_payment" IS NOT DISTINCT FROM OLD."fact_payment"
      AND NEW."fact_reason" IS NOT DISTINCT FROM OLD."fact_reason"
    ) THEN
      RAISE EXCEPTION 'The approved snapshot of this month is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "financial_periods" p WHERE p."id" = NEW."period_id" AND p."organization_id" = NEW."organization_id")
     OR NOT EXISTS (SELECT 1 FROM "employees" e WHERE e."id" = NEW."employee_id" AND e."organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'payroll_month_employees: month and employee must belong to the organization' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."period_id" <> OLD."period_id" OR NEW."employee_id" <> OLD."employee_id") THEN
    RAISE EXCEPTION 'payroll_month_employees: month and employee cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Payroll status flow: adds APPROVED -> CALCULATED for an audited re-open (otherwise unchanged).
CREATE OR REPLACE FUNCTION "fin_payroll_run_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Payroll run % is %; only drafts can be deleted (cancel it instead)', OLD."id", OLD."status"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "financial_periods" WHERE "id" = NEW."period_id" AND "organization_id" = NEW."organization_id"
  ) THEN
    RAISE EXCEPTION 'Payroll period belongs to another organization' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Payroll runs must be created as DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'Payroll run % is % and cannot be changed', OLD."id", OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status", NEW."status") IN (
      ('DRAFT', 'CALCULATED'), ('CALCULATED', 'DRAFT'), ('CALCULATED', 'SUBMITTED'),
      ('SUBMITTED', 'CALCULATED'), ('SUBMITTED', 'APPROVED'), ('APPROVED', 'PAYING'), ('PAYING', 'PAID')
    )
    -- Re-opening an approval (nothing paid yet): only inside the audited re-open transaction, which
    -- first records the approval in payroll_approval_versions.
    OR (
      OLD."status" = 'APPROVED' AND NEW."status" = 'CALCULATED'
      AND coalesce(current_setting('finance.payroll_reopen', true), '') = 'on'
      AND EXISTS (SELECT 1 FROM "payroll_approval_versions" v WHERE v."payroll_run_id" = NEW."id" AND v."reopened_at" = now())
    )
    OR (NEW."status" = 'CANCELLED' AND OLD."status" IN ('DRAFT', 'CALCULATED', 'SUBMITTED', 'APPROVED'))
  ) THEN
    RAISE EXCEPTION 'Invalid payroll status change % -> %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'APPROVED' AND OLD."status" <> 'APPROVED' AND NOT EXISTS (
    SELECT 1 FROM "payroll_approvals" WHERE "payroll_run_id" = NEW."id" AND "decision" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'Payroll run % has no recorded approval', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
