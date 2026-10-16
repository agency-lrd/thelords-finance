-- Password vault register: credential METADATA only (service, URL, username, owner, sharing). There is
-- deliberately no column for passwords or other secrets; those live in an external password manager.
-- Additive only: new enums, three new tables with RLS, two permissions, idempotent categories.

-- CreateEnum
CREATE TYPE "vault_access_level" AS ENUM ('STANDARD', 'SENSITIVE', 'CRITICAL');

-- CreateEnum
CREATE TYPE "vault_provider" AS ENUM ('BITWARDEN', 'ONEPASSWORD', 'OTHER');

-- CreateEnum
CREATE TYPE "vault_grant_level" AS ENUM ('VIEW', 'EDIT');

-- CreateTable
CREATE TABLE "vault_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vault_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "login_url" TEXT,
    "username" TEXT,
    "department_id" UUID,
    "category_id" UUID,
    "responsible_employee_id" UUID,
    "access_level" "vault_access_level" NOT NULL DEFAULT 'STANDARD',
    "vault_provider" "vault_provider",
    "vault_item_ref" TEXT,
    "notes" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vault_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_credential_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "credential_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "level" "vault_grant_level" NOT NULL DEFAULT 'VIEW',
    "granted_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "vault_credential_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vault_categories_organization_id_code_key" ON "vault_categories"("organization_id", "code");

-- CreateIndex
CREATE INDEX "vault_credentials_organization_id_department_id_idx" ON "vault_credentials"("organization_id", "department_id");

-- CreateIndex
CREATE INDEX "vault_credential_grants_user_id_idx" ON "vault_credential_grants"("user_id");

-- CreateIndex
CREATE INDEX "vault_credential_grants_credential_id_idx" ON "vault_credential_grants"("credential_id");

-- AddForeignKey
ALTER TABLE "vault_categories" ADD CONSTRAINT "vault_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "vault_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_responsible_employee_id_fkey" FOREIGN KEY ("responsible_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credentials" ADD CONSTRAINT "vault_credentials_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credential_grants" ADD CONSTRAINT "vault_credential_grants_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "vault_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credential_grants" ADD CONSTRAINT "vault_credential_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_credential_grants" ADD CONSTRAINT "vault_credential_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One active grant per user and credential; revoked grants stay as history.
CREATE UNIQUE INDEX "vault_credential_grants_active_key" ON "vault_credential_grants"("credential_id", "user_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "vault_credentials"
  ADD CONSTRAINT "vault_credentials_name_chk" CHECK (length(btrim("name")) BETWEEN 1 AND 160),
  ADD CONSTRAINT "vault_credentials_url_chk" CHECK ("login_url" IS NULL OR "login_url" ~* '^https?://'),
  ADD CONSTRAINT "vault_credentials_ref_chk" CHECK ("vault_item_ref" IS NULL OR length("vault_item_ref") <= 500);

-- Grants are history: never deleted, only revoked.
CREATE TRIGGER "vault_credential_grants_no_delete" BEFORE DELETE ON "vault_credential_grants"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();

-- ════════════════════════════════════════════════════════════════════════════
-- Row level security: API roles get nothing; policies document who may read.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "vault_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vault_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vault_credential_grants" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "vault_categories", "vault_credentials", "vault_credential_grants" FROM anon, authenticated;
  END IF;
END;
$$;

CREATE POLICY "vault_categories_read" ON "vault_categories" FOR SELECT TO authenticated
  USING ("finance_private"."is_member"("organization_id"));
-- Helpers (SECURITY DEFINER, like the other policy helpers) so the two policies do not recurse.
CREATE FUNCTION "finance_private"."vault_has_grant"(p_credential uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."vault_credential_grants"
    WHERE "credential_id" = p_credential AND "revoked_at" IS NULL AND "user_id" = "finance_private"."current_user_id"()
  )
$$;
CREATE FUNCTION "finance_private"."vault_credential_org"(p_credential uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT "organization_id" FROM public."vault_credentials" WHERE "id" = p_credential
$$;
REVOKE EXECUTE ON FUNCTION "finance_private"."vault_has_grant"(uuid), "finance_private"."vault_credential_org"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "finance_private"."vault_has_grant"(uuid), "finance_private"."vault_credential_org"(uuid) TO authenticated;

-- Company-wide: vault:manage (Owner) and Super Admin. Everyone else: only explicitly shared entries.
-- Department membership alone never grants access.
CREATE POLICY "vault_credentials_read" ON "vault_credentials" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'vault:manage') OR "finance_private"."vault_has_grant"("id"));
CREATE POLICY "vault_credential_grants_read" ON "vault_credential_grants" FOR SELECT TO authenticated
  USING ("user_id" = (SELECT "finance_private"."current_user_id"())
    OR "finance_private"."has_permission"("finance_private"."vault_credential_org"("credential_id"), 'vault:manage'));

-- ════════════════════════════════════════════════════════════════════════════
-- Permissions: vault:manage (all entries, sharing) and vault:audit (access history) for Owners.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO "permissions" ("key", "category", "description") VALUES
  ('vault:manage', 'vault', 'See and manage every credential entry and its sharing'),
  ('vault:audit',  'vault', 'See the access history of credential entries')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT r."id", p."key" FROM "roles" r CROSS JOIN (VALUES ('vault:manage'), ('vault:audit')) AS p("key")
WHERE r."key" = 'OWNER'
ON CONFLICT DO NOTHING;

-- Default roles for future organizations: the CFO role is "all permissions except ...", so exclude the
-- vault permissions explicitly (company-wide vault access is the Owner's). Same function otherwise.
CREATE OR REPLACE FUNCTION "finance_private"."create_default_roles"(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN SELECT * FROM (VALUES
    ('OWNER', 'Owner', 'Full control of the company, including ownership and distributions.', ARRAY(
      SELECT "key" FROM public."permissions")),
    ('CFO', 'CFO', 'All finance operations, payroll and salary approval, period close and lock.', ARRAY(
      SELECT "key" FROM public."permissions"
      WHERE "key" NOT IN ('organization:manage', 'users:manage', 'ownership:manage', 'distribution:approve')
        AND "key" NOT LIKE 'vault:%')),
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
-- Initial categories (editable, idempotent)
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION "finance_private"."create_vault_categories"(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public."vault_categories" ("organization_id", "code", "name", "sort_order", "updated_at")
  SELECT p_org, c.code, c.name, c.sort, now()
  FROM (VALUES
    ('ADS', 'Рекламные кабинеты', 10),
    ('SOCIAL', 'Социальные сети', 20),
    ('EMAIL', 'Почта', 30),
    ('CRM', 'CRM', 40),
    ('ANALYTICS', 'Аналитика', 50),
    ('AI', 'AI-инструменты', 60),
    ('HOSTING', 'Хостинг', 70),
    ('DOMAINS', 'Домены', 80),
    ('FINANCE', 'Финансовые платформы', 90),
    ('OTHER', 'Прочее', 100)
  ) AS c(code, name, sort)
  ON CONFLICT ("organization_id", "code") DO NOTHING;
$$;
REVOKE EXECUTE ON FUNCTION "finance_private"."create_vault_categories"(uuid) FROM PUBLIC;

SELECT "finance_private"."create_vault_categories"("id") FROM "organizations";
