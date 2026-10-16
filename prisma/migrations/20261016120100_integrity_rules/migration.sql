-- Integrity rules for THE LORDS Finance OS that Prisma's schema language cannot express.
-- Prisma does not manage CHECK constraints, triggers, functions or RLS, so they are kept here and
-- are not touched by later `prisma migrate` diffs. Review together with ../*_init_financial_schema.
--
-- Sections
--   1. Currencies                  5. General ledger consistency (double entry, immutability)
--   2. Value constraints           6. Payroll workflow (status flow, approvals, payments)
--   3. Shared helpers              7. Audit log: append-only
--   4. Historical data             8. Function privileges

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Currencies
-- ════════════════════════════════════════════════════════════════════════════
-- Every currency column is a foreign key to "currencies"; codes are upper-case ISO 4217 for fiat
-- or a ticker for digital assets (e.g. USDT).

ALTER TABLE "currencies"
  ADD CONSTRAINT "currencies_code_chk" CHECK ("code" ~ '^[A-Z][A-Z0-9]{2,9}$'),
  ADD CONSTRAINT "currencies_decimals_chk" CHECK ("decimals" BETWEEN 0 AND 8);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Value constraints
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_fiscal_year_start_month_chk" CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "organizations_country_iso_chk" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

ALTER TABLE "financial_periods"
  ADD CONSTRAINT "financial_periods_month_chk" CHECK ("month" BETWEEN 1 AND 12),
  ADD CONSTRAINT "financial_periods_dates_chk" CHECK ("end_date" >= "start_date"),
  ADD CONSTRAINT "financial_periods_closed_chk" CHECK ("status" IN ('OPEN', 'CLOSING') OR "closed_at" IS NOT NULL);

ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "exchange_rates_rate_chk" CHECK ("rate" > 0),
  ADD CONSTRAINT "exchange_rates_pair_chk" CHECK ("base_currency" <> "quote_currency");

-- Hierarchies cannot point at themselves.
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "financial_categories" ADD CONSTRAINT "financial_categories_parent_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- Date ranges: validFrom inclusive, validTo exclusive.
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "employee_assignments" ADD CONSTRAINT "employee_assignments_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "salary_conditions" ADD CONSTRAINT "salary_conditions_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "compensation_rules" ADD CONSTRAINT "compensation_rules_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "compensation_assignments" ADD CONSTRAINT "compensation_assignments_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "ownership_stakes" ADD CONSTRAINT "ownership_stakes_range_chk" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "employment_agreements" ADD CONSTRAINT "employment_agreements_range_chk" CHECK ("end_date" IS NULL OR "end_date" >= "start_date");
ALTER TABLE "employees" ADD CONSTRAINT "employees_termination_chk" CHECK ("termination_date" IS NULL OR "termination_date" >= "hire_date");
ALTER TABLE "projects" ADD CONSTRAINT "projects_range_chk" CHECK ("end_date" IS NULL OR "start_date" IS NULL OR "end_date" >= "start_date");

-- People and compensation
ALTER TABLE "employee_assignments" ADD CONSTRAINT "employee_assignments_allocation_chk" CHECK ("allocation_rate" > 0 AND "allocation_rate" <= 1);
ALTER TABLE "salary_conditions"
  ADD CONSTRAINT "salary_conditions_amount_chk" CHECK ("base_amount" >= 0),
  ADD CONSTRAINT "salary_conditions_hours_chk" CHECK ("pay_basis" NOT IN ('HOURLY', 'DAILY') OR ("standard_hours_per_month" IS NOT NULL AND "standard_hours_per_month" > 0));

ALTER TABLE "compensation_rules"
  ADD CONSTRAINT "compensation_rules_version_chk" CHECK ("version" >= 1),
  ADD CONSTRAINT "compensation_rules_method_chk" CHECK (
    ("method" = 'FIXED_AMOUNT' AND "fixed_amount" IS NOT NULL)
    OR ("method" IN ('PERCENT_OF_BASE', 'PERCENT_OF_METRIC', 'PER_UNIT') AND "rate" IS NOT NULL)
    OR "method" = 'TIERED'
  ),
  ADD CONSTRAINT "compensation_rules_currency_chk" CHECK ("fixed_amount" IS NULL OR "currency" IS NOT NULL),
  ADD CONSTRAINT "compensation_rules_bounds_chk" CHECK ("cap_amount" IS NULL OR "floor_amount" IS NULL OR "cap_amount" >= "floor_amount");

ALTER TABLE "compensation_rule_tiers"
  ADD CONSTRAINT "compensation_rule_tiers_range_chk" CHECK ("to_value" IS NULL OR "to_value" > "from_value"),
  ADD CONSTRAINT "compensation_rule_tiers_payout_chk" CHECK ("rate" IS NOT NULL OR "fixed_amount" IS NOT NULL);

ALTER TABLE "compensation_assignments"
  ADD CONSTRAINT "compensation_assignments_scope_chk" CHECK (num_nonnulls("department_id", "team_id", "employee_id") = 1);

-- KPI scope: exactly the FK for the scope is set, and scope_key mirrors it (makes the unique key work).
-- coalesce(..., false) so a NULL comparison fails the check instead of passing it.
ALTER TABLE "kpi_targets" ADD CONSTRAINT "kpi_targets_scope_chk" CHECK (coalesce(
  ("scope" = 'ORGANIZATION' AND num_nonnulls("department_id", "team_id", "employee_id") = 0 AND "scope_key" = 'ORG')
  OR ("scope" = 'DEPARTMENT' AND "department_id" IS NOT NULL AND num_nonnulls("team_id", "employee_id") = 0 AND "scope_key" = 'DEPARTMENT:' || "department_id")
  OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND num_nonnulls("department_id", "employee_id") = 0 AND "scope_key" = 'TEAM:' || "team_id")
  OR ("scope" = 'EMPLOYEE' AND "employee_id" IS NOT NULL AND num_nonnulls("department_id", "team_id") = 0 AND "scope_key" = 'EMPLOYEE:' || "employee_id"),
  false
));
ALTER TABLE "kpi_actuals" ADD CONSTRAINT "kpi_actuals_scope_chk" CHECK (coalesce(
  ("scope" = 'ORGANIZATION' AND num_nonnulls("department_id", "team_id", "employee_id") = 0 AND "scope_key" = 'ORG')
  OR ("scope" = 'DEPARTMENT' AND "department_id" IS NOT NULL AND num_nonnulls("team_id", "employee_id") = 0 AND "scope_key" = 'DEPARTMENT:' || "department_id")
  OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND num_nonnulls("department_id", "employee_id") = 0 AND "scope_key" = 'TEAM:' || "team_id")
  OR ("scope" = 'EMPLOYEE' AND "employee_id" IS NOT NULL AND num_nonnulls("department_id", "team_id") = 0 AND "scope_key" = 'EMPLOYEE:' || "employee_id"),
  false
));
ALTER TABLE "kpi_targets" ADD CONSTRAINT "kpi_targets_weight_chk" CHECK ("weight" IS NULL OR ("weight" >= 0 AND "weight" <= 1));

-- Payroll
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_sequence_chk" CHECK ("sequence" >= 1);
ALTER TABLE "payroll_items"
  ADD CONSTRAINT "payroll_items_amounts_chk" CHECK ("gross_amount" >= 0 AND "deductions_amount" >= 0 AND "employer_cost_amount" >= 0),
  ADD CONSTRAINT "payroll_items_net_chk" CHECK ("net_amount" = "gross_amount" - "deductions_amount"),
  ADD CONSTRAINT "payroll_items_fx_chk" CHECK ("fx_rate_to_base" > 0);
ALTER TABLE "payroll_adjustments"
  ADD CONSTRAINT "payroll_adjustments_amount_chk" CHECK ("amount" > 0),
  ADD CONSTRAINT "payroll_adjustments_decision_chk" CHECK ("status" IN ('PENDING', 'CANCELLED') OR "decided_at" IS NOT NULL);
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_step_chk" CHECK ("step" >= 1);
ALTER TABLE "payroll_payments"
  ADD CONSTRAINT "payroll_payments_amount_chk" CHECK ("amount" > 0 AND "base_amount" > 0 AND "fee_amount" >= 0),
  ADD CONSTRAINT "payroll_payments_fx_chk" CHECK ("fx_rate_to_base" > 0),
  ADD CONSTRAINT "payroll_payments_paid_chk" CHECK ("status" NOT IN ('SENT', 'CONFIRMED') OR "paid_at" IS NOT NULL);

-- Projects
ALTER TABLE "projects" ADD CONSTRAINT "projects_contract_value_chk" CHECK ("contract_value" IS NULL OR "contract_value" >= 0);
ALTER TABLE "project_income"
  ADD CONSTRAINT "project_income_amount_chk" CHECK ("amount" > 0 AND "base_amount" > 0),
  ADD CONSTRAINT "project_income_received_chk" CHECK ("received_amount" >= 0 AND "received_amount" <= "amount"),
  ADD CONSTRAINT "project_income_fx_chk" CHECK ("fx_rate_to_base" > 0);
ALTER TABLE "project_costs"
  ADD CONSTRAINT "project_costs_amount_chk" CHECK ("amount" > 0 AND "base_amount" > 0),
  ADD CONSTRAINT "project_costs_fx_chk" CHECK ("fx_rate_to_base" > 0);

-- Ledger: every line is a debit or a credit, never both, never zero.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amounts_chk" CHECK ("debit" >= 0 AND "credit" >= 0 AND ("debit" > 0) <> ("credit" > 0)),
  ADD CONSTRAINT "journal_lines_fx_chk" CHECK (
    ("transaction_currency" IS NULL AND "transaction_amount" IS NULL AND "fx_rate_to_base" IS NULL)
    OR ("transaction_currency" IS NOT NULL AND "transaction_amount" IS NOT NULL AND "fx_rate_to_base" IS NOT NULL AND "fx_rate_to_base" > 0)
  );
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_number_chk" CHECK ("entry_number" > 0),
  ADD CONSTRAINT "journal_entries_posted_chk" CHECK ("status" = 'DRAFT' OR ("posted_at" IS NOT NULL)),
  ADD CONSTRAINT "journal_entries_reversal_chk" CHECK ("reverses_entry_id" IS NULL OR "reverses_entry_id" <> "id");

-- Ownership and distributions
ALTER TABLE "ownership_stakes"
  ADD CONSTRAINT "ownership_stakes_share_chk" CHECK ("ownership_share" > 0 AND "ownership_share" <= 1),
  ADD CONSTRAINT "ownership_stakes_profit_share_chk" CHECK ("profit_share" IS NULL OR ("profit_share" >= 0 AND "profit_share" <= 1)),
  ADD CONSTRAINT "ownership_stakes_capital_chk" CHECK ("capital_contributed" >= 0);
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_amount_chk" CHECK ("total_amount" > 0);
ALTER TABLE "distribution_allocations"
  ADD CONSTRAINT "distribution_allocations_share_chk" CHECK ("share_applied" >= 0 AND "share_applied" <= 1),
  ADD CONSTRAINT "distribution_allocations_amount_chk" CHECK ("amount" >= 0 AND "withholding_amount" >= 0 AND "withholding_amount" <= "amount");

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Shared helpers
-- ════════════════════════════════════════════════════════════════════════════

-- Raises if the period is CLOSED or LOCKED. CLOSING is allowed at the database level; the
-- application restricts it to users holding the period:close permission.
CREATE FUNCTION "fin_assert_period_open"(p_period_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status "period_status";
BEGIN
  IF p_period_id IS NULL THEN
    RETURN;
  END IF;
  SELECT "status" INTO v_status FROM "financial_periods" WHERE "id" = p_period_id;
  IF v_status IN ('CLOSED', 'LOCKED') THEN
    RAISE EXCEPTION 'Financial period % is %; its data cannot be changed', p_period_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Generic period lock for tables with a period_id column. Trigger arguments name columns that may
-- still change after the period closes (settlement data such as payment status or received cash);
-- any other change to a row in a CLOSED/LOCKED period is rejected.
CREATE FUNCTION "fin_period_lock_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."period_id" = NEW."period_id"
     AND (to_jsonb(NEW) - TG_ARGV) = (to_jsonb(OLD) - TG_ARGV) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "fin_assert_period_open"(OLD."period_id");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM "fin_assert_period_open"(NEW."period_id");
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

-- Rejects UPDATE/DELETE (append-only tables).
CREATE FUNCTION "fin_append_only_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Prevents overlapping [valid_from, valid_to) ranges among rows sharing the key columns given as
-- trigger arguments. Serialized per key with a transaction advisory lock.
CREATE FUNCTION "fin_no_overlap_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_key text := TG_TABLE_NAME;
  v_where text := '';
  v_col text;
  v_conflict boolean;
BEGIN
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    v_key := v_key || ':' || coalesce(v_new ->> v_col, '');
    v_where := v_where || format(' AND %I::text IS NOT DISTINCT FROM %L', v_col, v_new ->> v_col);
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" <> $1'
    || ' AND daterange("valid_from"::date, "valid_to"::date, ''[)'') && daterange($2::date, $3::date, ''[)'')%s)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, v_where
  ) INTO v_conflict USING NEW."id", NEW."valid_from", NEW."valid_to";

  IF v_conflict THEN
    RAISE EXCEPTION 'Overlapping validity period in % for key (%)', TG_TABLE_NAME, array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Historical data: period locks and effective-dated history
-- ════════════════════════════════════════════════════════════════════════════

CREATE TRIGGER "kpi_targets_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "kpi_targets"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"();
CREATE TRIGGER "kpi_actuals_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "kpi_actuals"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"();
CREATE TRIGGER "payroll_runs_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"('status', 'pay_date', 'updated_at');
CREATE TRIGGER "payroll_adjustments_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"();
CREATE TRIGGER "project_income_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "project_income"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"('status', 'received_amount', 'received_date', 'updated_at');
CREATE TRIGGER "project_costs_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "project_costs"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"('status', 'paid_date', 'updated_at');
CREATE TRIGGER "distributions_period_lock" BEFORE INSERT OR UPDATE OR DELETE ON "distributions"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_lock_trg"('status', 'updated_at');

-- Period status: LOCKED is final, and a period cannot close with unposted journal entries.
CREATE FUNCTION "fin_period_status_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'LOCKED' THEN
    RAISE EXCEPTION 'Financial period % is LOCKED and cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('CLOSED', 'LOCKED') AND OLD."status" NOT IN ('CLOSED', 'LOCKED') AND EXISTS (
    SELECT 1 FROM "journal_entries" WHERE "period_id" = NEW."id" AND "status" = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Financial period % has draft journal entries; post or delete them before closing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "financial_periods_status" BEFORE UPDATE ON "financial_periods"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_status_trg"();
CREATE TRIGGER "financial_periods_no_delete" BEFORE DELETE ON "financial_periods"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();

-- No overlapping effective-dated history.
CREATE TRIGGER "salary_conditions_no_overlap" BEFORE INSERT OR UPDATE ON "salary_conditions"
  FOR EACH ROW EXECUTE FUNCTION "fin_no_overlap_trg"('employee_id');
CREATE TRIGGER "compensation_rules_no_overlap" BEFORE INSERT OR UPDATE ON "compensation_rules"
  FOR EACH ROW EXECUTE FUNCTION "fin_no_overlap_trg"('organization_id', 'code');
CREATE TRIGGER "compensation_assignments_no_overlap" BEFORE INSERT OR UPDATE ON "compensation_assignments"
  FOR EACH ROW EXECUTE FUNCTION "fin_no_overlap_trg"('rule_id', 'department_id', 'team_id', 'employee_id');
CREATE TRIGGER "ownership_stakes_no_overlap" BEFORE INSERT OR UPDATE ON "ownership_stakes"
  FOR EACH ROW EXECUTE FUNCTION "fin_no_overlap_trg"('shareholder_id', 'share_class');

-- Only one primary department assignment at a time; total allocation never exceeds 100%.
CREATE FUNCTION "fin_employee_assignment_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_over numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('employee_assignments:' || NEW."employee_id", 0));

  IF NEW."is_primary" AND EXISTS (
    SELECT 1 FROM "employee_assignments"
    WHERE "employee_id" = NEW."employee_id" AND "id" <> NEW."id" AND "is_primary"
      AND daterange("valid_from", "valid_to", '[)') && daterange(NEW."valid_from", NEW."valid_to", '[)')
  ) THEN
    RAISE EXCEPTION 'Employee % already has a primary assignment in this period', NEW."employee_id"
      USING ERRCODE = 'exclusion_violation';
  END IF;

  -- Check the allocation sum at every range start that falls inside the new row's range.
  SELECT max(total) INTO v_over FROM (
    SELECT d.day, sum(a."allocation_rate") AS total
    FROM (
      SELECT NEW."valid_from" AS day
      UNION
      SELECT "valid_from" FROM "employee_assignments"
      WHERE "employee_id" = NEW."employee_id" AND "id" <> NEW."id"
        AND daterange(NEW."valid_from", NEW."valid_to", '[)') @> "valid_from"
    ) d
    JOIN (
      SELECT "valid_from", "valid_to", "allocation_rate" FROM "employee_assignments"
      WHERE "employee_id" = NEW."employee_id" AND "id" <> NEW."id"
      UNION ALL
      SELECT NEW."valid_from", NEW."valid_to", NEW."allocation_rate"
    ) a ON daterange(a."valid_from", a."valid_to", '[)') @> d.day
    GROUP BY d.day
  ) s;
  IF v_over > 1 THEN
    RAISE EXCEPTION 'Employee % allocation would exceed 100%% (%)', NEW."employee_id", v_over
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "employee_assignments_rules" BEFORE INSERT OR UPDATE ON "employee_assignments"
  FOR EACH ROW EXECUTE FUNCTION "fin_employee_assignment_trg"();

-- Total active ownership in an organization never exceeds 100%.
CREATE FUNCTION "fin_ownership_total_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
  v_over numeric;
BEGIN
  SELECT "organization_id" INTO v_org FROM "shareholders" WHERE "id" = NEW."shareholder_id";
  PERFORM pg_advisory_xact_lock(hashtextextended('ownership:' || v_org, 0));

  SELECT max(total) INTO v_over FROM (
    SELECT d.day, sum(s."ownership_share") AS total
    FROM (
      SELECT NEW."valid_from" AS day
      UNION
      SELECT os."valid_from" FROM "ownership_stakes" os
      JOIN "shareholders" sh ON sh."id" = os."shareholder_id"
      WHERE sh."organization_id" = v_org AND os."id" <> NEW."id"
        AND daterange(NEW."valid_from", NEW."valid_to", '[)') @> os."valid_from"
    ) d
    JOIN (
      SELECT os."valid_from", os."valid_to", os."ownership_share" FROM "ownership_stakes" os
      JOIN "shareholders" sh ON sh."id" = os."shareholder_id"
      WHERE sh."organization_id" = v_org AND os."id" <> NEW."id"
      UNION ALL
      SELECT NEW."valid_from", NEW."valid_to", NEW."ownership_share"
    ) s ON daterange(s."valid_from", s."valid_to", '[)') @> d.day
    GROUP BY d.day
  ) t;
  IF v_over > 1 THEN
    RAISE EXCEPTION 'Total ownership would exceed 100%% (%)', v_over USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ownership_stakes_total" BEFORE INSERT OR UPDATE ON "ownership_stakes"
  FOR EACH ROW EXECUTE FUNCTION "fin_ownership_total_trg"();

-- ════════════════════════════════════════════════════════════════════════════
-- 5. General ledger consistency
-- ════════════════════════════════════════════════════════════════════════════

-- Journal entries: period belongs to the same organization and is open; posting requires a balanced
-- entry with at least two lines; posted entries are immutable except POSTED -> REVERSED.
CREATE FUNCTION "fin_journal_entry_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debit numeric;
  v_credit numeric;
  v_lines int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Journal entry % is %; only drafts can be deleted', OLD."id", OLD."status"
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM "fin_assert_period_open"(OLD."period_id");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT' THEN
    -- Marking a posted entry as reversed is the only permitted change, even in a closed period
    -- (the reversing entry itself is posted in an open period).
    IF OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED'
       AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Journal entry % is % and immutable; post a reversing entry instead', OLD."id", OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    PERFORM "fin_assert_period_open"(OLD."period_id");
  END IF;
  PERFORM "fin_assert_period_open"(NEW."period_id");

  IF NOT EXISTS (
    SELECT 1 FROM "financial_periods" p
    WHERE p."id" = NEW."period_id" AND p."organization_id" = NEW."organization_id"
      AND NEW."entry_date" BETWEEN p."start_date" AND p."end_date"
  ) THEN
    RAISE EXCEPTION 'Journal entry date % is outside its financial period or the period belongs to another organization', NEW."entry_date"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'REVERSED' THEN
    RAISE EXCEPTION 'A journal entry must be POSTED before it can be REVERSED' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'POSTED' THEN
    SELECT coalesce(sum("debit"), 0), coalesce(sum("credit"), 0), count(*)
      INTO v_debit, v_credit, v_lines
      FROM "journal_lines" WHERE "journal_entry_id" = NEW."id";
    IF v_lines < 2 OR v_debit <> v_credit OR v_debit = 0 THEN
      RAISE EXCEPTION 'Journal entry % is not balanced (lines %, debit %, credit %)', NEW."id", v_lines, v_debit, v_credit
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reverses_entry_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "journal_entries" WHERE "id" = NEW."reverses_entry_id" AND "status" IN ('POSTED', 'REVERSED')
        AND "organization_id" = NEW."organization_id"
    ) THEN
      RAISE EXCEPTION 'Reversed entry % must be a posted entry of the same organization', NEW."reverses_entry_id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_entries_rules" BEFORE INSERT OR UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "fin_journal_entry_trg"();

-- Journal lines: only editable while the entry is DRAFT; account must be postable, active and in the
-- entry's organization.
CREATE FUNCTION "fin_journal_line_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status "journal_status";
  v_org uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = OLD."journal_entry_id";
    IF v_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Journal entry % is %; its lines are immutable', OLD."journal_entry_id", v_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT "status", "organization_id" INTO v_status, v_org FROM "journal_entries" WHERE "id" = NEW."journal_entry_id";
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Journal entry % is %; lines cannot be added', NEW."journal_entry_id", v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ledger_accounts"
    WHERE "id" = NEW."ledger_account_id" AND "organization_id" = v_org AND "is_postable" AND "archived_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'Ledger account % is not a postable, active account of this organization', NEW."ledger_account_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."category_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "financial_categories" WHERE "id" = NEW."category_id" AND "organization_id" = v_org
  ) THEN
    RAISE EXCEPTION 'Category % belongs to another organization', NEW."category_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_lines_rules" BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "fin_journal_line_trg"();

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Payroll workflow
-- ════════════════════════════════════════════════════════════════════════════

-- Status flow: DRAFT <-> CALCULATED -> SUBMITTED -> APPROVED -> PAYING -> PAID; SUBMITTED can go back
-- to CALCULATED (changes requested); anything before PAYING can be CANCELLED. APPROVED requires a
-- recorded approval. PAID and CANCELLED are final.
CREATE FUNCTION "fin_payroll_run_trg"() RETURNS trigger
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
CREATE TRIGGER "payroll_runs_rules" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION "fin_payroll_run_trg"();

-- Payroll items and lines are editable only while the run is DRAFT or CALCULATED.
CREATE FUNCTION "fin_payroll_run_editable"(p_run_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status "payroll_run_status";
  v_period uuid;
BEGIN
  SELECT "status", "period_id" INTO v_status, v_period FROM "payroll_runs" WHERE "id" = p_run_id;
  PERFORM "fin_assert_period_open"(v_period);
  IF v_status NOT IN ('DRAFT', 'CALCULATED') THEN
    RAISE EXCEPTION 'Payroll run % is %; payslips can no longer be changed', p_run_id, v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE FUNCTION "fin_payroll_item_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "fin_payroll_run_editable"(OLD."payroll_run_id");
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  PERFORM "fin_payroll_run_editable"(NEW."payroll_run_id");
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payroll_items_rules" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_items"
  FOR EACH ROW EXECUTE FUNCTION "fin_payroll_item_trg"();

CREATE FUNCTION "fin_payroll_line_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid;
  v_employee uuid;
  v_period uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "payroll_run_id" INTO v_run FROM "payroll_items" WHERE "id" = OLD."payroll_item_id";
    PERFORM "fin_payroll_run_editable"(v_run);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT i."payroll_run_id", i."employee_id", r."period_id" INTO v_run, v_employee, v_period
    FROM "payroll_items" i JOIN "payroll_runs" r ON r."id" = i."payroll_run_id"
    WHERE i."id" = NEW."payroll_item_id";
  PERFORM "fin_payroll_run_editable"(v_run);

  -- An applied adjustment must be approved and belong to the same employee and period.
  IF NEW."adjustment_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "payroll_adjustments"
    WHERE "id" = NEW."adjustment_id" AND "employee_id" = v_employee AND "period_id" = v_period
      AND "status" IN ('APPROVED', 'APPLIED')
  ) THEN
    RAISE EXCEPTION 'Adjustment % is not approved for this employee and period', NEW."adjustment_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payroll_item_lines_rules" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_item_lines"
  FOR EACH ROW EXECUTE FUNCTION "fin_payroll_line_trg"();

-- Payments only for approved runs; the paid-to wallet must belong to the paid employee.
CREATE FUNCTION "fin_payroll_payment_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payroll_items" i JOIN "payroll_runs" r ON r."id" = i."payroll_run_id"
    WHERE i."id" = NEW."payroll_item_id" AND r."status" IN ('APPROVED', 'PAYING', 'PAID')
  ) THEN
    RAISE EXCEPTION 'Payroll item % is not in an approved payroll run', NEW."payroll_item_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "payroll_items" i JOIN "payout_wallets" w ON w."employee_id" = i."employee_id"
    WHERE i."id" = NEW."payroll_item_id" AND w."id" = NEW."payout_wallet_id"
  ) THEN
    RAISE EXCEPTION 'Payout wallet % does not belong to the paid employee', NEW."payout_wallet_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payroll_payments_rules" BEFORE INSERT OR UPDATE ON "payroll_payments"
  FOR EACH ROW EXECUTE FUNCTION "fin_payroll_payment_trg"();
CREATE TRIGGER "payroll_payments_no_delete" BEFORE DELETE ON "payroll_payments"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();

-- Approval decisions are an immutable trail.
CREATE TRIGGER "payroll_approvals_append_only" BEFORE UPDATE OR DELETE ON "payroll_approvals"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Audit log: append-only
-- ════════════════════════════════════════════════════════════════════════════

CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();
CREATE TRIGGER "audit_logs_no_truncate" BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "fin_append_only_trg"();

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Function privileges
-- ════════════════════════════════════════════════════════════════════════════
-- RLS and privilege revocation for the tables happen in *_init_financial_schema itself, so the
-- tables are never exposed between migrations. Here: the integrity functions created above.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
  END IF;
END;
$$;

-- Helper functions are internal; nobody calls them directly (trigger functions cannot be called anyway).
REVOKE EXECUTE ON FUNCTION "fin_assert_period_open"(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "fin_payroll_run_editable"(uuid) FROM PUBLIC;
