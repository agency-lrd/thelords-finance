-- Business targets for the AI CFO gap analysis. Additive only.

-- CreateTable
CREATE TABLE "financial_targets" (
    "organization_id" UUID NOT NULL,
    "net_profit_monthly" DECIMAL(20,2),
    "revenue_monthly" DECIMAL(20,2),
    "ebitda_margin_pct" DECIMAL(6,2),
    "cash_reserve_months" DECIMAL(5,2),
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "financial_targets_pkey" PRIMARY KEY ("organization_id")
);

-- AddForeignKey
ALTER TABLE "financial_targets" ADD CONSTRAINT "financial_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_targets" ADD CONSTRAINT "financial_targets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "financial_targets"
  ADD CONSTRAINT "financial_targets_revenue_chk" CHECK ("revenue_monthly" IS NULL OR "revenue_monthly" >= 0),
  ADD CONSTRAINT "financial_targets_margin_chk" CHECK ("ebitda_margin_pct" IS NULL OR "ebitda_margin_pct" BETWEEN -100 AND 100),
  ADD CONSTRAINT "financial_targets_reserve_chk" CHECK ("cash_reserve_months" IS NULL OR "cash_reserve_months" BETWEEN 0 AND 60);

ALTER TABLE "financial_targets" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "financial_targets" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "financial_targets_read" ON "financial_targets" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'reports:read'));
