-- Manual KPI bonus override per employee-month ("Изменить бонус вручную"). Additive only.
-- When set, it replaces the automatic KPI bonus (never added to it); null = automatic calculation.
ALTER TABLE "payroll_month_employees" ADD COLUMN "kpi_bonus_override" NUMERIC(20, 2);
ALTER TABLE "payroll_month_employees" ADD COLUMN "kpi_bonus_reason" TEXT;
ALTER TABLE "payroll_month_employees" ADD COLUMN "kpi_bonus_set_by_id" UUID;
ALTER TABLE "payroll_month_employees" ADD COLUMN "kpi_bonus_set_at" TIMESTAMPTZ(6);
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_kpi_bonus_override_check" CHECK ("kpi_bonus_override" IS NULL OR "kpi_bonus_override" >= 0);
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_kpi_bonus_set_by_id_fkey" FOREIGN KEY ("kpi_bonus_set_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Approved snapshots stay immutable; re-opening may only clear the snapshot (now also checks the new columns).
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
      AND NEW."kpi_bonus_override" IS NOT DISTINCT FROM OLD."kpi_bonus_override"
      AND NEW."kpi_bonus_reason" IS NOT DISTINCT FROM OLD."kpi_bonus_reason"
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
