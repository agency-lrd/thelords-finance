-- Manual transactions, budgets and the reporting chart of accounts. Additive only: new enums, two new
-- tables (with RLS), constraints and triggers on those tables, and idempotent configuration rows.

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('REVENUE', 'OPERATING_EXPENSE', 'PAYROLL', 'INTERNAL_TRANSFER', 'OWNER_CONTRIBUTION', 'OWNER_WITHDRAWAL', 'LOAN_RECEIVED', 'LOAN_REPAYMENT', 'INVESTMENT', 'TAX_PAYMENT', 'ASSET_PURCHASE', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "settlement_status" AS ENUM ('PAID', 'UNPAID', 'PARTIAL');

-- CreateEnum
CREATE TYPE "budget_scenario" AS ENUM ('BASE', 'CONSERVATIVE', 'AGGRESSIVE');

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "transaction_type" NOT NULL,
    "status" "transaction_status" NOT NULL DEFAULT 'DRAFT',
    "date" DATE NOT NULL,
    "period_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "fx_rate_to_base" DECIMAL(28,12) NOT NULL DEFAULT 1,
    "base_amount" DECIMAL(24,8) NOT NULL,
    "fee_amount" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "financial_account_id" UUID,
    "counter_financial_account_id" UUID,
    "category_id" UUID,
    "debit_account_id" UUID,
    "credit_account_id" UUID,
    "department_id" UUID,
    "client_id" UUID,
    "project_id" UUID,
    "shareholder_id" UUID,
    "counterparty" TEXT,
    "direction" VARCHAR(3),
    "settlement_status" "settlement_status" NOT NULL DEFAULT 'PAID',
    "settled_amount" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "due_date" DATE,
    "notes" TEXT,
    "attachment_url" TEXT,
    "external_ref" TEXT,
    "journal_entry_id" UUID,
    "created_by_id" UUID,
    "posted_by_id" UUID,
    "posted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "month" SMALLINT NOT NULL,
    "scenario" "budget_scenario" NOT NULL DEFAULT 'BASE',
    "metric" TEXT NOT NULL,
    "ledger_account_id" UUID,
    "department_id" UUID,
    "project_id" UUID,
    "scope_key" TEXT NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_journal_entry_id_key" ON "transactions"("journal_entry_id");

-- CreateIndex
CREATE INDEX "transactions_organization_id_date_idx" ON "transactions"("organization_id", "date");

-- CreateIndex
CREATE INDEX "transactions_period_id_idx" ON "transactions"("period_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_organization_id_number_key" ON "transactions"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_organization_id_external_ref_key" ON "transactions"("organization_id", "external_ref");

-- CreateIndex
CREATE INDEX "budget_lines_organization_id_year_idx" ON "budget_lines"("organization_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "budget_lines_organization_id_year_month_scenario_scope_key_key" ON "budget_lines"("organization_id", "year", "month", "scenario", "scope_key");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "financial_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counter_financial_account_id_fkey" FOREIGN KEY ("counter_financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "financial_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_debit_account_id_fkey" FOREIGN KEY ("debit_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_shareholder_id_fkey" FOREIGN KEY ("shareholder_id") REFERENCES "shareholders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ════════════════════════════════════════════════════════════════════════════
-- Constraints and rules
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_number_chk" CHECK ("number" > 0),
  ADD CONSTRAINT "transactions_amount_chk" CHECK ("amount" > 0 AND "base_amount" > 0 AND "fee_amount" >= 0),
  ADD CONSTRAINT "transactions_fx_chk" CHECK ("fx_rate_to_base" > 0),
  ADD CONSTRAINT "transactions_settled_chk" CHECK ("settled_amount" >= 0 AND "settled_amount" <= "amount"),
  ADD CONSTRAINT "transactions_direction_chk" CHECK ("direction" IS NULL OR "direction" IN ('IN', 'OUT')),
  ADD CONSTRAINT "transactions_posted_chk" CHECK ("status" = 'DRAFT' OR "journal_entry_id" IS NOT NULL),
  ADD CONSTRAINT "transactions_transfer_chk" CHECK ("type" <> 'INTERNAL_TRANSFER' OR "counter_financial_account_id" IS DISTINCT FROM "financial_account_id");

ALTER TABLE "budget_lines"
  ADD CONSTRAINT "budget_lines_month_chk" CHECK ("month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "budget_lines_metric_chk" CHECK ("metric" IN ('REVENUE', 'DIRECT_COSTS', 'OPEX', 'PAYROLL', 'MARKETING', 'NET_PROFIT', 'EBITDA', 'CASH_RESERVE', 'ACCOUNT')),
  ADD CONSTRAINT "budget_lines_account_chk" CHECK (("metric" = 'ACCOUNT') = ("ledger_account_id" IS NOT NULL));

-- Rows of closed months are frozen; settlement fields and the posting link may still change.
CREATE TRIGGER "transactions_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"('status', 'settlement_status', 'settled_amount', 'journal_entry_id', 'posted_by_id', 'posted_at', 'updated_at');

-- Only drafts can be deleted; posted transactions are reversed instead.
CREATE FUNCTION "fin_transaction_delete_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Transaction % is %; reverse it instead of deleting', OLD."number", OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "transactions_no_delete_posted" BEFORE DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "fin_transaction_delete_trg"();

-- ════════════════════════════════════════════════════════════════════════════
-- Row level security (read-only for API roles, like every other table)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "transactions", "budget_lines" FROM anon, authenticated;
    REVOKE ALL ON FUNCTION "fin_transaction_delete_trg"() FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "transactions_read" ON "transactions" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'ledger:read'));
CREATE POLICY "budget_lines_read" ON "budget_lines" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'reports:read'));

-- ════════════════════════════════════════════════════════════════════════════
-- Reporting configuration: P&L lines as ledger accounts (classification by chart of accounts),
-- matching categories, and manually entered KPIs. Idempotent.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION "finance_private"."create_reporting_configuration"(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_base text;
BEGIN
  SELECT "base_currency" INTO v_base FROM public."organizations" WHERE "id" = p_org;

  INSERT INTO public."ledger_accounts"
    ("organization_id", "code", "name", "type", "subtype", "normal_balance", "cash_flow_activity", "is_postable", "updated_at")
  SELECT p_org, a.code, a.name, a.type::public."account_type", a.subtype::public."account_subtype",
         a.nb::public."normal_balance", a.cfa::public."cash_flow_activity", true, now()
  FROM (VALUES
    ('1550', 'Intangible assets',               'ASSET',     'INTANGIBLE_ASSET',        'DEBIT',  'INVESTING'),
    ('1600', 'Investments',                     'ASSET',     'OTHER_NON_CURRENT_ASSET', 'DEBIT',  'INVESTING'),
    ('2650', 'Short-term loans',                'LIABILITY', 'SHORT_TERM_DEBT',         'CREDIT', 'FINANCING'),
    ('4010', 'Management fees',                 'REVENUE',   'OPERATING_REVENUE',       'CREDIT', 'OPERATING'),
    ('4020', 'Influencer marketing revenue',    'REVENUE',   'OPERATING_REVENUE',       'CREDIT', 'OPERATING'),
    ('4030', 'AI production revenue',           'REVENUE',   'OPERATING_REVENUE',       'CREDIT', 'OPERATING'),
    ('4040', 'Media buying revenue',            'REVENUE',   'OPERATING_REVENUE',       'CREDIT', 'OPERATING'),
    ('4050', 'Clipping revenue',                'REVENUE',   'OPERATING_REVENUE',       'CREDIT', 'OPERATING'),
    ('4090', 'Other operating revenue',         'REVENUE',   'OPERATING_REVENUE',       'CREDIT', 'OPERATING'),
    ('5050', 'Delivery bonuses',                'EXPENSE',   'COST_OF_SALES',           'DEBIT',  'OPERATING'),
    ('5300', 'Direct campaign expenses',        'EXPENSE',   'COST_OF_SALES',           'DEBIT',  'OPERATING'),
    ('5400', 'Influencer payments',             'EXPENSE',   'COST_OF_SALES',           'DEBIT',  'OPERATING'),
    ('5500', 'Streamer payments',               'EXPENSE',   'COST_OF_SALES',           'DEBIT',  'OPERATING'),
    ('5900', 'Other direct costs',              'EXPENSE',   'COST_OF_SALES',           'DEBIT',  'OPERATING'),
    ('6050', 'Employee bonuses',                'EXPENSE',   'OPERATING_EXPENSE',       'DEBIT',  'OPERATING'),
    ('6500', 'Operational expenses',            'EXPENSE',   'OPERATING_EXPENSE',       'DEBIT',  'OPERATING'),
    ('6600', 'Administration',                  'EXPENSE',   'OPERATING_EXPENSE',       'DEBIT',  'OPERATING'),
    ('6700', 'Business development',            'EXPENSE',   'OPERATING_EXPENSE',       'DEBIT',  'OPERATING'),
    ('6800', 'HR expenses',                     'EXPENSE',   'OPERATING_EXPENSE',       'DEBIT',  'OPERATING')
  ) AS a(code, name, type, subtype, nb, cfa)
  ON CONFLICT ("organization_id", "code") DO NOTHING;

  INSERT INTO public."financial_categories" ("organization_id", "kind", "code", "name", "ledger_account_id", "sort_order", "updated_at")
  SELECT p_org, c.kind::public."category_kind", c.code, c.name, la."id", c.sort, now()
  FROM (VALUES
    ('REVENUE',           'MANAGEMENT-FEES',    'Management fees',              '4010', 11),
    ('REVENUE',           'INFLUENCER-REVENUE', 'Influencer marketing revenue', '4020', 12),
    ('REVENUE',           'AI-REVENUE',         'AI production revenue',        '4030', 13),
    ('REVENUE',           'MEDIA-BUYING',       'Media buying revenue',         '4040', 14),
    ('REVENUE',           'CLIPPING-REVENUE',   'Clipping revenue',             '4050', 15),
    ('REVENUE',           'OTHER-REVENUE',      'Other operating revenue',      '4090', 19),
    ('COST_OF_SALES',     'CAMPAIGN-COSTS',     'Direct campaign expenses',     '5300', 33),
    ('COST_OF_SALES',     'INFLUENCER-PAY',     'Influencer payments',          '5400', 34),
    ('COST_OF_SALES',     'STREAMER-PAY',       'Streamer payments',            '5500', 35),
    ('COST_OF_SALES',     'OTHER-DIRECT',       'Other direct costs',           '5900', 39),
    ('OPERATING_EXPENSE', 'OPERATIONS',         'Operational expenses',         '6500', 45),
    ('OPERATING_EXPENSE', 'ADMINISTRATION',     'Administration',               '6600', 46),
    ('OPERATING_EXPENSE', 'BIZDEV',             'Business development',         '6700', 47),
    ('OPERATING_EXPENSE', 'HR',                 'HR expenses',                  '6800', 48)
  ) AS c(kind, code, name, account, sort)
  JOIN public."ledger_accounts" la ON la."organization_id" = p_org AND la."code" = c.account
  ON CONFLICT ("organization_id", "code") DO NOTHING;

  -- Manually entered monthly indicators (organization scope).
  INSERT INTO public."kpi_definitions" ("organization_id", "code", "name", "description", "unit", "currency", "direction", "aggregation", "updated_at")
  VALUES
    (p_org, 'CLIENT_NPS', 'Client NPS', 'Net promoter score from client surveys (-100 to 100).', 'RATIO', NULL, 'HIGHER_IS_BETTER', 'LAST', now()),
    (p_org, 'EMPLOYEE_NPS', 'Employee NPS', 'Net promoter score from team surveys (-100 to 100).', 'RATIO', NULL, 'HIGHER_IS_BETTER', 'LAST', now()),
    (p_org, 'MANAGED_BUDGET', 'Managed client budget', 'Client advertising budgets managed by the agency (turnover). Not agency revenue.', 'CURRENCY', v_base, 'HIGHER_IS_BETTER', 'SUM', now())
  ON CONFLICT ("organization_id", "code") DO NOTHING;
END;
$$;
REVOKE EXECUTE ON FUNCTION "finance_private"."create_reporting_configuration"(uuid) FROM PUBLIC;

SELECT "finance_private"."create_reporting_configuration"("id") FROM "organizations";
