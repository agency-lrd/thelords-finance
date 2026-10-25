-- Simple cash register, client categories, Influence team income/costs and stable ordering. Additive only.

-- Owner-facing kind of a cash movement (client payment, salary, owner distribution, ...). The
-- accounting type (and so the double-entry template) stays in "type"; kind only labels and groups.
ALTER TABLE "transactions" ADD COLUMN "kind" VARCHAR(40);
ALTER TABLE "transactions" ADD COLUMN "team_id" UUID;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "transactions_organization_id_kind_idx" ON "transactions"("organization_id", "kind");
CREATE INDEX "transactions_shareholder_id_idx" ON "transactions"("shareholder_id");
CREATE INDEX "transactions_client_id_idx" ON "transactions"("client_id");

-- Client categories (Casino, E-commerce, ...): editable list with stable order.
CREATE TABLE "client_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "client_categories_organization_id_name_key" ON "client_categories"("organization_id", "name");
ALTER TABLE "client_categories" ADD CONSTRAINT "client_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clients" ADD COLUMN "category_id" UUID;
ALTER TABLE "clients" ADD CONSTRAINT "clients_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "client_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "client_categories" ("organization_id", "name", "sort_order")
SELECT o."id", c."name", c."sort_order"
FROM "organizations" o
CROSS JOIN (VALUES ('Casino', 10), ('White / Non-Gambling', 20), ('E-commerce', 30), ('Gambling', 40), ('Game Provider', 50), ('CS Market', 60)) AS c("name", "sort_order")
ON CONFLICT DO NOTHING;

ALTER TABLE "client_categories" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "client_categories" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "client_categories_read" ON "client_categories" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'client:read'));

-- Teams: explicit order. Team costs and recurring (planned monthly) costs on the project ledger.
ALTER TABLE "teams" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "project_costs" ADD COLUMN "team_id" UUID;
ALTER TABLE "project_costs" ADD COLUMN "recurring" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project_costs" ADD COLUMN "carried_from_id" UUID;
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_carried_from_id_fkey" FOREIGN KEY ("carried_from_id") REFERENCES "project_costs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "project_costs_team_id_idx" ON "project_costs"("team_id");
CREATE UNIQUE INDEX "project_costs_period_id_carried_from_id_key" ON "project_costs"("period_id", "carried_from_id");

-- Categories keep a stable, explicit order: today's order (position, then creation), numbered.
UPDATE "financial_categories" c SET "sort_order" = o."pos" * 10
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "organization_id", "kind" ORDER BY "sort_order", "created_at", "id") AS "pos"
  FROM "financial_categories"
) o
WHERE o."id" = c."id";
UPDATE "teams" t SET "sort_order" = o."pos" * 10
FROM (SELECT "id", row_number() OVER (PARTITION BY "department_id" ORDER BY "created_at", "id") AS "pos" FROM "teams") o
WHERE o."id" = t."id";
