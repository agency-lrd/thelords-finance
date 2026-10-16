-- Role-based authorization and row level security for THE LORDS Finance OS.
--
-- Access model
--   * The server (Prisma, connected as the table owner) is the only writer. It checks permissions in
--     application code; the database additionally verifies that approvers/posters hold the right
--     permission (section 4).
--   * Supabase Data API (PostgREST/GraphQL) access is read-only and governed by the policies below.
--     `anon` has no privileges and no policies: anonymous users can never read financial data.
--     `authenticated` currently has NO table privileges either (revoked in *_integrity_rules); the
--     policies are in place so read access can later be opened with a reviewed GRANT SELECT.
--   * Permissions come from roles granted per organization (user_role_assignments), optionally
--     limited to one department. Platform super admins (app_users.is_super_admin) see everything.
--     Employees always see their own records (payslips, salary history, KPIs, wallets).
--
-- Helper functions live in schema "finance_private", which the Data API does not expose. They are
-- SECURITY DEFINER with an empty search_path so policies can check roles without recursive RLS.

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Supabase API roles (already present on Supabase; created only on plain Postgres, e.g. the
--    Prisma shadow database, so this migration is portable)
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
END;
$$;

-- Defense in depth: make sure the API roles hold nothing on the financial tables.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

CREATE SCHEMA "finance_private";
REVOKE ALL ON SCHEMA "finance_private" FROM PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Identity and permission helpers
-- ════════════════════════════════════════════════════════════════════════════

-- Supabase user id from the request JWT (same source as auth.uid(), without depending on the auth schema).
CREATE FUNCTION "finance_private"."current_user_id"() RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;

CREATE FUNCTION "finance_private"."user_is_super_admin"(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."app_users" WHERE "id" = p_user AND "is_super_admin" AND "status" = 'ACTIVE'
  )
$$;

-- Core check for any user. p_department: NULL = needs an organization-wide grant; otherwise a grant
-- scoped to that department also counts.
CREATE FUNCTION "finance_private"."user_has_permission"(p_user uuid, p_org uuid, p_permission text, p_department uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_user IS NOT NULL AND (
    "finance_private"."user_is_super_admin"(p_user)
    OR EXISTS (
      SELECT 1
      FROM public."user_role_assignments" a
      JOIN public."role_permissions" rp ON rp."role_id" = a."role_id"
      JOIN public."roles" r ON r."id" = a."role_id" AND r."organization_id" = a."organization_id"
      JOIN public."app_users" u ON u."id" = a."user_id"
      WHERE a."user_id" = p_user
        AND a."organization_id" = p_org
        AND rp."permission_key" = p_permission
        AND u."status" = 'ACTIVE'
        AND a."valid_from" <= now() AND (a."valid_to" IS NULL OR a."valid_to" > now())
        AND (a."scope_department_id" IS NULL OR a."scope_department_id" = p_department)
    )
  )
$$;

-- Wrappers for the current request's user.
CREATE FUNCTION "finance_private"."is_super_admin"() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "finance_private"."user_is_super_admin"("finance_private"."current_user_id"())
$$;

CREATE FUNCTION "finance_private"."has_permission"(p_org uuid, p_permission text, p_department uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "finance_private"."user_has_permission"("finance_private"."current_user_id"(), p_org, p_permission, p_department)
$$;

-- Holds the permission organization-wide or for at least one department (e.g. to see payroll run headers).
CREATE FUNCTION "finance_private"."has_any_scope_permission"(p_org uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "finance_private"."is_super_admin"() OR EXISTS (
    SELECT 1
    FROM public."user_role_assignments" a
    JOIN public."role_permissions" rp ON rp."role_id" = a."role_id"
    JOIN public."app_users" u ON u."id" = a."user_id"
    WHERE a."user_id" = "finance_private"."current_user_id"()
      AND a."organization_id" = p_org AND rp."permission_key" = p_permission AND u."status" = 'ACTIVE'
      AND a."valid_from" <= now() AND (a."valid_to" IS NULL OR a."valid_to" > now())
  )
$$;

-- Any active role in the organization.
CREATE FUNCTION "finance_private"."is_member"(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "finance_private"."is_super_admin"() OR EXISTS (
    SELECT 1 FROM public."user_role_assignments" a JOIN public."app_users" u ON u."id" = a."user_id"
    WHERE a."user_id" = "finance_private"."current_user_id"() AND a."organization_id" = p_org
      AND u."status" = 'ACTIVE' AND a."valid_from" <= now() AND (a."valid_to" IS NULL OR a."valid_to" > now())
  )
$$;

-- The employee record belongs to the current user.
CREATE FUNCTION "finance_private"."is_self"(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_employee IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."employees"
    WHERE "id" = p_employee AND "user_id" = "finance_private"."current_user_id"()
  )
$$;

CREATE FUNCTION "finance_private"."is_self_shareholder"(p_shareholder uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."shareholders"
    WHERE "id" = p_shareholder AND "user_id" = "finance_private"."current_user_id"()
  )
$$;

-- Permission over an employee: organization-wide, or scoped to a department the employee currently
-- belongs to.
CREATE FUNCTION "finance_private"."can_access_employee"(p_employee uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."employees" e
    WHERE e."id" = p_employee AND (
      "finance_private"."has_permission"(e."organization_id", p_permission)
      OR EXISTS (
        SELECT 1 FROM public."employee_assignments" ea
        WHERE ea."employee_id" = e."id"
          AND ea."valid_from" <= current_date AND (ea."valid_to" IS NULL OR ea."valid_to" > current_date)
          AND "finance_private"."has_permission"(e."organization_id", p_permission, ea."department_id")
      )
    )
  )
$$;

-- Permission over a record scoped to a department, team or employee (KPIs, payslips).
CREATE FUNCTION "finance_private"."can_access_scope"(p_org uuid, p_permission text, p_department uuid, p_team uuid, p_employee uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "finance_private"."has_permission"(p_org, p_permission)
    OR (p_department IS NOT NULL AND "finance_private"."has_permission"(p_org, p_permission, p_department))
    OR (p_team IS NOT NULL AND EXISTS (
      SELECT 1 FROM public."teams" t WHERE t."id" = p_team
        AND "finance_private"."has_permission"(p_org, p_permission, t."department_id")
    ))
    OR (p_employee IS NOT NULL AND "finance_private"."can_access_employee"(p_employee, p_permission))
$$;

-- Organization lookups for child tables (bypass RLS on the parent).
CREATE FUNCTION "finance_private"."payroll_run_org"(p_run uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "organization_id" FROM public."payroll_runs" WHERE "id" = p_run
$$;

CREATE FUNCTION "finance_private"."distribution_org"(p_distribution uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "organization_id" FROM public."distributions" WHERE "id" = p_distribution
$$;

CREATE FUNCTION "finance_private"."compensation_rule_org"(p_rule uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "organization_id" FROM public."compensation_rules" WHERE "id" = p_rule
$$;

-- Policies run as the querying role, which needs USAGE/EXECUTE. The schema is not exposed by the
-- Data API, so these cannot be called as RPCs. user_has_permission/user_is_super_admin take an
-- arbitrary user id and stay private to the owner.
GRANT USAGE ON SCHEMA "finance_private" TO authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "finance_private" FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "finance_private"."current_user_id"(),
  "finance_private"."is_super_admin"(),
  "finance_private"."has_permission"(uuid, text, uuid),
  "finance_private"."has_any_scope_permission"(uuid, text),
  "finance_private"."is_member"(uuid),
  "finance_private"."is_self"(uuid),
  "finance_private"."is_self_shareholder"(uuid),
  "finance_private"."can_access_employee"(uuid, text),
  "finance_private"."can_access_scope"(uuid, text, uuid, uuid, uuid),
  "finance_private"."payroll_run_org"(uuid),
  "finance_private"."distribution_org"(uuid),
  "finance_private"."compensation_rule_org"(uuid)
TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Default roles (created per organization)
-- ════════════════════════════════════════════════════════════════════════════
-- Super Admin is platform-wide (app_users.is_super_admin), not a per-organization role.
-- Segregation of duties: HR manages salaries, CFO/Owner approve them; Finance Manager prepares and
-- pays payroll, CFO/Owner approve it; Owner approves distributions.

CREATE FUNCTION "finance_private"."create_default_roles"(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN SELECT * FROM (VALUES
    ('OWNER', 'Owner', 'Full control of the company, including ownership and distributions.', ARRAY(
      SELECT "key" FROM public."permissions")),
    ('CFO', 'CFO', 'All finance operations, payroll and salary approval, period close and lock.', ARRAY(
      SELECT "key" FROM public."permissions"
      WHERE "key" NOT IN ('organization:manage', 'users:manage', 'ownership:manage', 'distribution:approve'))),
    ('FINANCE_MANAGER', 'Finance Manager', 'Bookkeeping, project finance, payroll preparation and payment.', ARRAY[
      'period:close', 'structure:read', 'employee:read', 'salary:read', 'compensation:read', 'kpi:read',
      'payroll:read', 'payroll:prepare', 'payroll:pay', 'adjustment:request', 'wallet:read',
      'client:read', 'client:manage', 'project:read', 'project:manage', 'project_finance:read', 'project_finance:manage',
      'ledger:read', 'ledger:manage', 'journal:create', 'journal:post', 'reports:read', 'distribution:read']),
    ('DEPARTMENT_HEAD', 'Department Head', 'Team, KPIs, payroll and projects of the assigned department only.', ARRAY[
      'structure:read', 'employee:read', 'kpi:read', 'kpi:manage', 'payroll:read', 'adjustment:request',
      'project:read', 'project_finance:read', 'reports:read']),
    ('HR', 'HR', 'Employees, agreements, salary changes (approved by CFO/Owner), wallets.', ARRAY[
      'structure:read', 'structure:manage', 'employee:read', 'employee:manage', 'agreement:read', 'agreement:manage',
      'salary:read', 'salary:manage', 'compensation:read', 'kpi:read', 'payroll:read', 'adjustment:request',
      'wallet:read', 'wallet:manage']),
    ('EMPLOYEE', 'Employee', 'Own profile, payslips, salary history, KPIs and payout wallets.', ARRAY[
      'structure:read']::text[]),
    ('READ_ONLY', 'Read Only', 'Financial reports, ledger and projects; no personal or salary data.', ARRAY[
      'structure:read', 'kpi:read', 'client:read', 'project:read', 'project_finance:read', 'ledger:read', 'reports:read'])
  ) AS t("key", "name", "description", "permissions") LOOP
    INSERT INTO public."roles" ("organization_id", "key", "name", "description", "is_system", "updated_at")
    VALUES (p_org, v_role."key", v_role."name", v_role."description", true, now())
    ON CONFLICT ("organization_id", "key") DO NOTHING;

    INSERT INTO public."role_permissions" ("role_id", "permission_key")
    SELECT r."id", p."key"
    FROM public."roles" r
    JOIN public."permissions" p ON p."key" = ANY (v_role."permissions")
    WHERE r."organization_id" = p_org AND r."key" = v_role."key"
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Row level security policies (SELECT only; all writes go through the server)
-- ════════════════════════════════════════════════════════════════════════════

-- Reference data
CREATE POLICY "currencies_read" ON "currencies" FOR SELECT TO authenticated USING (true);
CREATE POLICY "permissions_read" ON "permissions" FOR SELECT TO authenticated USING (true);

-- Organization, users and roles
CREATE POLICY "organizations_read" ON "organizations" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("id"));
CREATE POLICY "app_users_read" ON "app_users" FOR SELECT TO authenticated
  USING ("id" = (SELECT "finance_private"."current_user_id"())
    OR (SELECT "finance_private"."is_super_admin"())
    OR EXISTS (
      SELECT 1 FROM "user_role_assignments" a
      WHERE a."user_id" = "app_users"."id" AND "finance_private"."has_permission"(a."organization_id", 'users:manage')
    ));
CREATE POLICY "roles_read" ON "roles" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));
CREATE POLICY "role_permissions_read" ON "role_permissions" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "roles" r WHERE r."id" = "role_id"));
CREATE POLICY "user_role_assignments_read" ON "user_role_assignments" FOR SELECT TO authenticated
  USING ("user_id" = (SELECT "finance_private"."current_user_id"())
    OR "finance_private"."has_permission"("organization_id", 'users:manage'));

-- Periods, FX, structure, categories (non-sensitive configuration visible to members)
CREATE POLICY "financial_periods_read" ON "financial_periods" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));
CREATE POLICY "exchange_rates_read" ON "exchange_rates" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));
CREATE POLICY "departments_read" ON "departments" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));
CREATE POLICY "teams_read" ON "teams" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "departments" d WHERE d."id" = "department_id"));
CREATE POLICY "financial_categories_read" ON "financial_categories" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));
CREATE POLICY "kpi_definitions_read" ON "kpi_definitions" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));

-- People (self, or permission over the employee's department)
CREATE POLICY "employees_read" ON "employees" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("id") OR "finance_private"."can_access_employee"("id", 'employee:read'));
CREATE POLICY "employee_assignments_read" ON "employee_assignments" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id") OR "finance_private"."can_access_employee"("employee_id", 'employee:read'));
CREATE POLICY "employment_agreements_read" ON "employment_agreements" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id") OR "finance_private"."can_access_employee"("employee_id", 'agreement:read'));
CREATE POLICY "salary_conditions_read" ON "salary_conditions" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id") OR "finance_private"."can_access_employee"("employee_id", 'salary:read'));
CREATE POLICY "payout_wallets_read" ON "payout_wallets" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id") OR "finance_private"."can_access_employee"("employee_id", 'wallet:read'));

-- Compensation rules (employees see the rules assigned to them)
CREATE POLICY "compensation_rules_read" ON "compensation_rules" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'compensation:read')
    OR EXISTS (
      SELECT 1 FROM "compensation_assignments" ca
      WHERE ca."rule_id" = "compensation_rules"."id" AND "finance_private"."is_self"(ca."employee_id")
    ));
CREATE POLICY "compensation_rule_tiers_read" ON "compensation_rule_tiers" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "compensation_rules" r WHERE r."id" = "rule_id"));
CREATE POLICY "compensation_assignments_read" ON "compensation_assignments" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id")
    OR "finance_private"."has_permission"("finance_private"."compensation_rule_org"("rule_id"), 'compensation:read'));

-- KPIs
CREATE POLICY "kpi_targets_read" ON "kpi_targets" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id")
    OR "finance_private"."can_access_scope"("organization_id", 'kpi:read', "department_id", "team_id", "employee_id"));
CREATE POLICY "kpi_actuals_read" ON "kpi_actuals" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id")
    OR "finance_private"."can_access_scope"("organization_id", 'kpi:read', "department_id", "team_id", "employee_id"));

-- Payroll
CREATE POLICY "payroll_runs_read" ON "payroll_runs" FOR SELECT TO authenticated
  USING ("finance_private"."has_any_scope_permission"("organization_id", 'payroll:read')
    OR EXISTS (
      SELECT 1 FROM "payroll_items" i
      WHERE i."payroll_run_id" = "payroll_runs"."id" AND "finance_private"."is_self"(i."employee_id")
    ));
CREATE POLICY "payroll_items_read" ON "payroll_items" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id")
    OR "finance_private"."can_access_scope"("finance_private"."payroll_run_org"("payroll_run_id"), 'payroll:read', "department_id", "team_id", NULL));
CREATE POLICY "payroll_item_lines_read" ON "payroll_item_lines" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "payroll_items" i WHERE i."id" = "payroll_item_id"));
CREATE POLICY "payroll_payments_read" ON "payroll_payments" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "payroll_items" i WHERE i."id" = "payroll_item_id"));
CREATE POLICY "payroll_adjustments_read" ON "payroll_adjustments" FOR SELECT TO authenticated
  USING ("finance_private"."is_self"("employee_id")
    OR "requested_by_id" = (SELECT "finance_private"."current_user_id"())
    OR "finance_private"."can_access_scope"("organization_id", 'payroll:read', NULL, NULL, "employee_id"));
CREATE POLICY "payroll_approvals_read" ON "payroll_approvals" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("finance_private"."payroll_run_org"("payroll_run_id"), 'payroll:read'));

-- Clients and projects (department heads see their department's projects)
CREATE POLICY "clients_read" ON "clients" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'client:read'));
CREATE POLICY "projects_read" ON "projects" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'project:read', "department_id")
    OR "finance_private"."is_self"("manager_employee_id"));
CREATE POLICY "project_income_read" ON "project_income" FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM "projects" p WHERE p."id" = "project_id"
      AND "finance_private"."has_permission"(p."organization_id", 'project_finance:read', p."department_id")
  ));
CREATE POLICY "project_costs_read" ON "project_costs" FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM "projects" p WHERE p."id" = "project_id"
      AND "finance_private"."has_permission"(p."organization_id", 'project_finance:read', p."department_id")
  ));

-- Ledger (organization-wide ledger:read only; department reports are built server-side)
CREATE POLICY "ledger_accounts_read" ON "ledger_accounts" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'ledger:read'));
CREATE POLICY "financial_accounts_read" ON "financial_accounts" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'ledger:read'));
CREATE POLICY "journal_entries_read" ON "journal_entries" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'ledger:read'));
CREATE POLICY "journal_lines_read" ON "journal_lines" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "journal_entries" je WHERE je."id" = "journal_entry_id"));

-- Ownership (shareholders see their own stakes and allocations)
CREATE POLICY "shareholders_read" ON "shareholders" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'ownership:read')
    OR "user_id" = (SELECT "finance_private"."current_user_id"()));
CREATE POLICY "ownership_stakes_read" ON "ownership_stakes" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "shareholders" s WHERE s."id" = "shareholder_id"));
CREATE POLICY "distribution_allocations_read" ON "distribution_allocations" FOR SELECT TO authenticated
  USING ("finance_private"."is_self_shareholder"("shareholder_id")
    OR "finance_private"."has_permission"("finance_private"."distribution_org"("distribution_id"), 'distribution:read'));
CREATE POLICY "distributions_read" ON "distributions" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'distribution:read')
    OR EXISTS (
      SELECT 1 FROM "distribution_allocations" da
      WHERE da."distribution_id" = "distributions"."id" AND "finance_private"."is_self_shareholder"(da."shareholder_id")
    ));

-- Audit
CREATE POLICY "audit_logs_read" ON "audit_logs" FOR SELECT TO authenticated
  USING (CASE WHEN "organization_id" IS NULL THEN (SELECT "finance_private"."is_super_admin"())
              ELSE "finance_private"."has_permission"("organization_id", 'audit:read') END);

-- Every public table must have RLS enabled and at least one policy decision documented here.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t.tablename, ', ') INTO v_missing
  FROM pg_tables t
  WHERE t.schemaname = 'public' AND t.tablename <> '_prisma_migrations'
    AND (NOT t.rowsecurity OR NOT EXISTS (
      SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tablename
    ));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Tables without RLS policy: %', v_missing;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Authorization checks on critical actions (enforced for every writer, including the server)
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION "finance_private"."require_permission"(p_user uuid, p_org uuid, p_permission text, p_action text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user IS NOT NULL AND NOT "finance_private"."user_has_permission"(p_user, p_org, p_permission) THEN
    RAISE EXCEPTION 'User % lacks permission % required to %', p_user, p_permission, p_action
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION "finance_private"."require_permission"(uuid, uuid, text, text) FROM PUBLIC;

-- Payroll approvals: the approver must hold payroll:approve (APPROVED/REJECTED alike).
CREATE FUNCTION "fin_payroll_approval_authz_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "finance_private"."require_permission"(
    NEW."approver_id", "finance_private"."payroll_run_org"(NEW."payroll_run_id"), 'payroll:approve', 'approve payroll');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payroll_approvals_authz" BEFORE INSERT ON "payroll_approvals"
  FOR EACH ROW EXECUTE FUNCTION "fin_payroll_approval_authz_trg"();

-- Salary changes: approver must hold salary:approve.
CREATE FUNCTION "fin_salary_approval_authz_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW."approved_by_id" IS NOT NULL THEN
    SELECT "organization_id" INTO v_org FROM "employees" WHERE "id" = NEW."employee_id";
    PERFORM "finance_private"."require_permission"(NEW."approved_by_id", v_org, 'salary:approve', 'approve salary changes');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "salary_conditions_authz" BEFORE INSERT OR UPDATE OF "approved_by_id" ON "salary_conditions"
  FOR EACH ROW EXECUTE FUNCTION "fin_salary_approval_authz_trg"();

-- Payroll adjustments: approver must hold adjustment:approve.
CREATE FUNCTION "fin_adjustment_authz_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "finance_private"."require_permission"(NEW."approved_by_id", NEW."organization_id", 'adjustment:approve', 'approve payroll adjustments');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payroll_adjustments_authz" BEFORE INSERT OR UPDATE OF "approved_by_id" ON "payroll_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "fin_adjustment_authz_trg"();

-- Journal posting: poster must hold journal:post.
CREATE FUNCTION "fin_journal_post_authz_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "finance_private"."require_permission"(NEW."posted_by_id", NEW."organization_id", 'journal:post', 'post journal entries');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "journal_entries_authz" BEFORE INSERT OR UPDATE OF "posted_by_id" ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "fin_journal_post_authz_trg"();

-- Distributions: approver must hold distribution:approve.
CREATE FUNCTION "fin_distribution_authz_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "finance_private"."require_permission"(NEW."approved_by_id", NEW."organization_id", 'distribution:approve', 'approve distributions');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "distributions_authz" BEFORE INSERT OR UPDATE OF "approved_by_id" ON "distributions"
  FOR EACH ROW EXECUTE FUNCTION "fin_distribution_authz_trg"();

-- Period close/reopen/lock: the closing user must hold the matching permission.
CREATE FUNCTION "fin_period_authz_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."closed_by_id" IS NOT NULL THEN
    PERFORM "finance_private"."require_permission"(
      NEW."closed_by_id", NEW."organization_id",
      CASE NEW."status" WHEN 'LOCKED' THEN 'period:lock' WHEN 'OPEN' THEN 'period:reopen' ELSE 'period:close' END,
      'change the period status');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "financial_periods_authz" BEFORE UPDATE ON "financial_periods"
  FOR EACH ROW EXECUTE FUNCTION "fin_period_authz_trg"();

-- A Department Head grant is meaningless without a department: require the scope.
CREATE FUNCTION "fin_role_assignment_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = NEW."role_id" AND "organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'Role % does not belong to organization %', NEW."role_id", NEW."organization_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."scope_department_id" IS NULL AND EXISTS (SELECT 1 FROM "roles" WHERE "id" = NEW."role_id" AND "key" = 'DEPARTMENT_HEAD') THEN
    RAISE EXCEPTION 'Department Head assignments require scope_department_id' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."scope_department_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "departments" WHERE "id" = NEW."scope_department_id" AND "organization_id" = NEW."organization_id"
  ) THEN
    RAISE EXCEPTION 'Scope department belongs to another organization' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "user_role_assignments_rules" BEFORE INSERT OR UPDATE ON "user_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "fin_role_assignment_trg"();

-- Role grants are security events: revoke by setting valid_to, never by deleting the history.
CREATE TRIGGER "user_role_assignments_no_delete" BEFORE DELETE ON "user_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();
