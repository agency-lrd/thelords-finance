-- Financial sheet support and default configuration. Additive only: new nullable/defaulted columns,
-- one enum, one function, and idempotent reference rows. No existing data is changed or removed.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Schema additions
-- ════════════════════════════════════════════════════════════════════════════

CREATE TYPE "metric_basis" AS ENUM ('TOTAL', 'ABOVE_TARGET', 'TOTAL_IF_TARGET_MET');

ALTER TABLE "employees" ADD COLUMN "archived_at" TIMESTAMPTZ(6),
ADD COLUMN "is_team_lead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "notes" TEXT;

ALTER TABLE "compensation_rules" ADD COLUMN "metric_basis" "metric_basis" NOT NULL DEFAULT 'TOTAL';

ALTER TABLE "payroll_items" ADD COLUMN "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN "confirmed_by_id" UUID;

ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A confirmation always records who confirmed and when.
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_confirmed_chk"
  CHECK (("confirmed_at" IS NULL) = ("confirmed_by_id" IS NULL));

-- Rules measured against a KPI target need a KPI.
ALTER TABLE "compensation_rules" ADD CONSTRAINT "compensation_rules_metric_basis_chk"
  CHECK ("metric_basis" = 'TOTAL' OR "kpi_definition_id" IS NOT NULL);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Default configuration per organization (departments, chart of accounts, categories, KPI)
-- ════════════════════════════════════════════════════════════════════════════
-- Configuration only: names and account structure, editable afterwards. Idempotent.

CREATE FUNCTION "finance_private"."create_default_configuration"(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_base text;
BEGIN
  SELECT "base_currency" INTO v_base FROM public."organizations" WHERE "id" = p_org;

  -- Departments. Delivery teams' payroll is cost of sales; support functions are operating expense.
  INSERT INTO public."departments" ("organization_id", "code", "name", "cost_classification", "updated_at")
  SELECT p_org, d.code, d.name, d.cls::public."category_kind", now()
  FROM (VALUES
    ('INFLULORDS', 'InfluLords', 'COST_OF_SALES'),
    ('VIRALVERSE', 'ViralVerse / Clipping', 'COST_OF_SALES'),
    ('TRAFFICLORDS', 'TrafficLords', 'COST_OF_SALES'),
    ('AI-PRODUCTION', 'AI Production', 'COST_OF_SALES'),
    ('MARKETING', 'Marketing', 'OPERATING_EXPENSE'),
    ('BIZDEV', 'Business Development', 'OPERATING_EXPENSE'),
    ('OPERATIONS', 'Operations', 'OPERATING_EXPENSE'),
    ('HR', 'HR', 'OPERATING_EXPENSE'),
    ('SPECIAL-PROJECTS', 'Special Projects', 'COST_OF_SALES')
  ) AS d(code, name, cls)
  ON CONFLICT ("organization_id", "code") DO NOTHING;

  -- Chart of accounts. Header accounts (is_postable = false) group money accounts created in the app.
  INSERT INTO public."ledger_accounts"
    ("organization_id", "code", "name", "type", "subtype", "normal_balance", "cash_flow_activity", "is_postable", "updated_at")
  SELECT p_org, a.code, a.name, a.type::public."account_type", a.subtype::public."account_subtype",
         a.nb::public."normal_balance", a.cfa::public."cash_flow_activity", a.postable, now()
  FROM (VALUES
    ('1000', 'Cash and cash equivalents',      'ASSET',     'CASH',                     'DEBIT',  'NONE',      false),
    ('1200', 'Accounts receivable',            'ASSET',     'RECEIVABLE',               'DEBIT',  'OPERATING', true),
    ('1300', 'Employee advances',              'ASSET',     'OTHER_CURRENT_ASSET',      'DEBIT',  'OPERATING', true),
    ('1400', 'Prepaid expenses',               'ASSET',     'PREPAID',                  'DEBIT',  'OPERATING', true),
    ('1500', 'Equipment',                      'ASSET',     'FIXED_ASSET',              'DEBIT',  'INVESTING', true),
    ('1590', 'Accumulated depreciation',       'ASSET',     'ACCUMULATED_DEPRECIATION', 'CREDIT', 'INVESTING', true),
    ('2000', 'Accounts payable',               'LIABILITY', 'PAYABLE',                  'CREDIT', 'OPERATING', true),
    ('2100', 'Payroll payable',                'LIABILITY', 'PAYROLL_LIABILITY',        'CREDIT', 'OPERATING', true),
    ('2200', 'Taxes payable',                  'LIABILITY', 'TAX_LIABILITY',            'CREDIT', 'OPERATING', true),
    ('2300', 'Accrued liabilities',            'LIABILITY', 'ACCRUED_LIABILITY',        'CREDIT', 'OPERATING', true),
    ('2400', 'Deferred revenue',               'LIABILITY', 'DEFERRED_REVENUE',         'CREDIT', 'OPERATING', true),
    ('2500', 'Client advertising budgets held','LIABILITY', 'OTHER_LIABILITY',          'CREDIT', 'OPERATING', true),
    ('2600', 'Loans',                          'LIABILITY', 'LONG_TERM_DEBT',           'CREDIT', 'FINANCING', true),
    ('2700', 'Distributions payable',          'LIABILITY', 'DISTRIBUTIONS_PAYABLE',    'CREDIT', 'FINANCING', true),
    ('3000', 'Owner capital',                  'EQUITY',    'OWNER_CAPITAL',            'CREDIT', 'FINANCING', true),
    ('3100', 'Retained earnings',              'EQUITY',    'RETAINED_EARNINGS',        'CREDIT', 'NONE',      true),
    ('3200', 'Owner distributions',            'EQUITY',    'DISTRIBUTIONS',            'DEBIT',  'FINANCING', true),
    ('4000', 'Agency revenue',                 'REVENUE',   'OPERATING_REVENUE',        'CREDIT', 'OPERATING', true),
    ('4900', 'Other income',                   'REVENUE',   'OTHER_INCOME',             'CREDIT', 'OPERATING', true),
    ('5000', 'Delivery payroll',               'EXPENSE',   'COST_OF_SALES',            'DEBIT',  'OPERATING', true),
    ('5100', 'Contractors and freelancers',    'EXPENSE',   'COST_OF_SALES',            'DEBIT',  'OPERATING', true),
    ('5200', 'Production tools and services',  'EXPENSE',   'COST_OF_SALES',            'DEBIT',  'OPERATING', true),
    ('6000', 'Overhead payroll',               'EXPENSE',   'OPERATING_EXPENSE',        'DEBIT',  'OPERATING', true),
    ('6100', 'Software and subscriptions',     'EXPENSE',   'OPERATING_EXPENSE',        'DEBIT',  'OPERATING', true),
    ('6200', 'Marketing',                      'EXPENSE',   'OPERATING_EXPENSE',        'DEBIT',  'OPERATING', true),
    ('6300', 'Rent and office',                'EXPENSE',   'OPERATING_EXPENSE',        'DEBIT',  'OPERATING', true),
    ('6400', 'Bank and payment fees',          'EXPENSE',   'OPERATING_EXPENSE',        'DEBIT',  'OPERATING', true),
    ('6900', 'Other operating expenses',       'EXPENSE',   'OPERATING_EXPENSE',        'DEBIT',  'OPERATING', true),
    ('7000', 'Depreciation',                   'EXPENSE',   'DEPRECIATION',             'DEBIT',  'OPERATING', true),
    ('7100', 'Amortization',                   'EXPENSE',   'AMORTIZATION',             'DEBIT',  'OPERATING', true),
    ('8000', 'Interest expense',               'EXPENSE',   'INTEREST_EXPENSE',         'DEBIT',  'OPERATING', true),
    ('8100', 'Interest income',                'REVENUE',   'INTEREST_INCOME',          'CREDIT', 'OPERATING', true),
    ('8500', 'FX gains and losses',            'EXPENSE',   'OTHER_EXPENSE',            'DEBIT',  'OPERATING', true),
    ('9000', 'Income tax',                     'EXPENSE',   'INCOME_TAX',               'DEBIT',  'OPERATING', true)
  ) AS a(code, name, type, subtype, nb, cfa, postable)
  ON CONFLICT ("organization_id", "code") DO NOTHING;

  -- Income and expense categories, each posting to a ledger account.
  INSERT INTO public."financial_categories" ("organization_id", "kind", "code", "name", "ledger_account_id", "sort_order", "updated_at")
  SELECT p_org, c.kind::public."category_kind", c.code, c.name, la."id", c.sort, now()
  FROM (VALUES
    ('REVENUE',           'AGENCY-REVENUE',     'Agency revenue',                '4000', 10),
    ('OTHER_INCOME',      'OTHER-INCOME',       'Other income',                  '4900', 20),
    ('COST_OF_SALES',     'DELIVERY-PAYROLL',   'Delivery payroll',              '5000', 30),
    ('COST_OF_SALES',     'CONTRACTORS',        'Contractors and freelancers',   '5100', 31),
    ('COST_OF_SALES',     'PRODUCTION-TOOLS',   'Production tools and services', '5200', 32),
    ('OPERATING_EXPENSE', 'OVERHEAD-PAYROLL',   'Overhead payroll',              '6000', 40),
    ('OPERATING_EXPENSE', 'SOFTWARE',           'Software and subscriptions',    '6100', 41),
    ('OPERATING_EXPENSE', 'MARKETING',          'Marketing',                     '6200', 42),
    ('OPERATING_EXPENSE', 'RENT',               'Rent and office',               '6300', 43),
    ('OPERATING_EXPENSE', 'BANK-FEES',          'Bank and payment fees',         '6400', 44),
    ('OPERATING_EXPENSE', 'OTHER-OPEX',         'Other operating expenses',      '6900', 49),
    ('DEPRECIATION',      'DEPRECIATION',       'Depreciation',                  '7000', 50),
    ('AMORTIZATION',      'AMORTIZATION',       'Amortization',                  '7100', 51),
    ('INTEREST',          'INTEREST',           'Interest',                      '8000', 60),
    ('OTHER_EXPENSE',     'FX',                 'FX gains and losses',           '8500', 70),
    ('TAX',               'INCOME-TAX',         'Income tax',                    '9000', 80)
  ) AS c(kind, code, name, account, sort)
  JOIN public."ledger_accounts" la ON la."organization_id" = p_org AND la."code" = c.account
  ON CONFLICT ("organization_id", "code") DO NOTHING;

  -- KPI used by profit-based compensation (the KPI Profit / KPI Fact columns of the sheet).
  INSERT INTO public."kpi_definitions" ("organization_id", "code", "name", "description", "unit", "currency", "updated_at")
  VALUES (p_org, 'PROFIT', 'Profit', 'Profit generated by the employee or team in the month (KPI Profit target vs KPI Fact).',
          'CURRENCY', v_base, now())
  ON CONFLICT ("organization_id", "code") DO NOTHING;
END;
$$;
REVOKE EXECUTE ON FUNCTION "finance_private"."create_default_configuration"(uuid) FROM PUBLIC;

SELECT "finance_private"."create_default_configuration"("id") FROM "organizations";
