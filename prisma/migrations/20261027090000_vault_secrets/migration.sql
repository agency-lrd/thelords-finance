-- Encrypted password storage for the credential register. Additive only.
-- The secret is encrypted in the application (AES-256-GCM, dedicated VAULT_ENCRYPTION_KEYS) before it
-- reaches the database; only ciphertext is stored, in its own table, so no list query, report, export
-- or AI tool that reads vault_credentials ever touches it.

CREATE TABLE "vault_secrets" (
    "credential_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key_id" VARCHAR(40) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vault_secrets_pkey" PRIMARY KEY ("credential_id")
);
CREATE INDEX "vault_secrets_organization_id_idx" ON "vault_secrets"("organization_id");
CREATE INDEX "vault_secrets_key_id_idx" ON "vault_secrets"("key_id");
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "vault_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vault_secrets" ADD CONSTRAINT "vault_secrets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The secret's organization is the credential's organization.
CREATE FUNCTION "vault_secret_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "vault_credentials" c WHERE c."id" = NEW."credential_id" AND c."organization_id" = NEW."organization_id") THEN
    RAISE EXCEPTION 'vault_secrets: credential and organization must match' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "vault_secrets_rules" BEFORE INSERT OR UPDATE ON "vault_secrets"
  FOR EACH ROW EXECUTE FUNCTION "vault_secret_trg"();

-- No client access at all: no policies, and every privilege revoked from the API roles.
ALTER TABLE "vault_secrets" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "vault_secrets" FROM anon, authenticated;
  END IF;
END;
$$;

-- Departments: explicit order for the "Отделы и категории" screen and dropdowns (today's order: by name).
ALTER TABLE "departments" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
UPDATE "departments" d SET "sort_order" = o."pos" * 10
FROM (SELECT "id", row_number() OVER (PARTITION BY "organization_id" ORDER BY "name", "id") AS "pos" FROM "departments") o
WHERE o."id" = d."id";
