-- Saved financial plans (AI CFO planning): a named, fixed plan per month, compared with actuals.
-- Plans are planning records only; they never create or change transactions, payroll or the ledger.

CREATE TABLE "financial_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "assumptions" TEXT,
    "revenue" NUMERIC(24, 2),
    "direct_costs" NUMERIC(24, 2),
    "operating_expenses" NUMERIC(24, 2),
    "payroll" NUMERIC(24, 2),
    "hiring_cost" NUMERIC(24, 2),
    "profit" NUMERIC(24, 2),
    "cash_balance" NUMERIC(24, 2),
    "fixed_at" TIMESTAMPTZ(6),
    "fixed_by_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "financial_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "financial_plans_month_check" CHECK ("month" BETWEEN 1 AND 12 AND "year" BETWEEN 2000 AND 2100)
);
CREATE INDEX "financial_plans_organization_id_year_month_idx" ON "financial_plans"("organization_id", "year", "month");
ALTER TABLE "financial_plans" ADD CONSTRAINT "financial_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_plans" ADD CONSTRAINT "financial_plans_fixed_by_id_fkey" FOREIGN KEY ("fixed_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_plans" ADD CONSTRAINT "financial_plans_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A fixed plan cannot be changed (only archived), so comparisons stay honest.
CREATE FUNCTION "financial_plan_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."fixed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A fixed plan cannot be deleted (archive it instead)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."fixed_at" IS NOT NULL AND (
    NEW."name" IS DISTINCT FROM OLD."name" OR NEW."year" <> OLD."year" OR NEW."month" <> OLD."month"
    OR NEW."assumptions" IS DISTINCT FROM OLD."assumptions" OR NEW."revenue" IS DISTINCT FROM OLD."revenue"
    OR NEW."direct_costs" IS DISTINCT FROM OLD."direct_costs" OR NEW."operating_expenses" IS DISTINCT FROM OLD."operating_expenses"
    OR NEW."payroll" IS DISTINCT FROM OLD."payroll" OR NEW."hiring_cost" IS DISTINCT FROM OLD."hiring_cost"
    OR NEW."profit" IS DISTINCT FROM OLD."profit" OR NEW."cash_balance" IS DISTINCT FROM OLD."cash_balance"
    OR NEW."fixed_at" IS DISTINCT FROM OLD."fixed_at"
  ) THEN
    RAISE EXCEPTION 'A fixed plan cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "financial_plans_rules" BEFORE UPDATE OR DELETE ON "financial_plans"
  FOR EACH ROW EXECUTE FUNCTION "financial_plan_trg"();

ALTER TABLE "financial_plans" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "financial_plans" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "financial_plans_read" ON "financial_plans" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'reports:read'));
