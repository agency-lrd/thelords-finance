-- Monthly payroll rosters with immutable approval snapshots. Additive: a new table, backfilled from existing payslips.

-- CreateEnum
CREATE TYPE "month_member_source" AS ENUM ('NEW', 'CARRIED', 'LEGACY');

-- CreateTable
CREATE TABLE "payroll_month_employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "source" "month_member_source" NOT NULL,
    "carried_from_period_id" UUID,
    "snapshot" JSONB,
    "snapshot_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_month_employees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_month_employees_employee_id_idx" ON "payroll_month_employees"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_month_employees_period_id_employee_id_key" ON "payroll_month_employees"("period_id", "employee_id");

-- AddForeignKey
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_carried_from_period_id_fkey" FOREIGN KEY ("carried_from_period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_month_employees" ADD CONSTRAINT "payroll_month_employees_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The organization of a roster row is the organization of its month and employee.
CREATE FUNCTION "payroll_month_employee_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."snapshot" IS NOT NULL THEN
    RAISE EXCEPTION 'The approved snapshot of this month is immutable' USING ERRCODE = 'insufficient_privilege';
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
CREATE TRIGGER "payroll_month_employees_rules" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_month_employees"
  FOR EACH ROW EXECUTE FUNCTION "payroll_month_employee_trg"();

ALTER TABLE "payroll_month_employees" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "payroll_month_employees" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "payroll_month_employees_read" ON "payroll_month_employees" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'payroll:read'));

-- Existing months: every employee with a payslip in a month is on that month's roster.
INSERT INTO "payroll_month_employees" ("organization_id", "period_id", "employee_id", "source")
SELECT DISTINCT r."organization_id", r."period_id", i."employee_id", 'LEGACY'::"month_member_source"
FROM "payroll_items" i JOIN "payroll_runs" r ON r."id" = i."payroll_run_id"
WHERE r."status" <> 'CANCELLED'
ON CONFLICT DO NOTHING;
