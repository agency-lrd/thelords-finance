-- Employee positions (job titles) as a directory, separate from departments. Additive only.
-- Position is effective-dated on the employee assignment (like the department) and frozen in approved
-- monthly snapshots, so a change in one month never rewrites an earlier month.

CREATE TABLE "positions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_ru" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "positions_organization_id_name_key" ON "positions"("organization_id", "name");
CREATE INDEX "positions_organization_id_sort_order_idx" ON "positions"("organization_id", "sort_order");
ALTER TABLE "positions" ADD CONSTRAINT "positions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "positions" FROM anon, authenticated;
  END IF;
END;
$$;
CREATE POLICY "positions_read" ON "positions" FOR SELECT TO authenticated
  USING ("finance_private"."has_permission"("organization_id", 'employee:read'));

-- Default directory, idempotent (running again never duplicates or renames existing positions).
INSERT INTO "positions" ("organization_id", "name", "sort_order")
SELECT o."id", p."name", p."sort_order"
FROM "organizations" o
CROSS JOIN (VALUES
('Influencer Manager', 10),
('Searcher', 20),
('Team Lead', 30),
('Head of Influencer Marketing', 40),
('Crypto Influencer Manager', 50),
('BizDev Manager', 60),
('Sales Manager', 70),
('BizDev Team Lead', 80),
('Project Manager', 90),
('AI Creator', 100),
('Account Manager', 110),
('SMM Manager', 120),
('Creative Producer', 130),
('Scriptwriter', 140),
('Motion Designer', 150),
('Video Editor', 160),
('Graphic Designer', 170),
('Media Buyer', 180),
('Media Buying Team Lead', 190),
('Head of Traffic', 200),
('Financial Manager', 210),
('Accountant', 220),
('HR Manager', 230),
('Recruiter', 240),
('Operations Manager', 250),
('Data Analyst', 260),
('Developer', 270),
('QA Specialist', 280),
('Marketing Manager', 290),
('Head of Marketing', 300)
) AS p("name", "sort_order")
ON CONFLICT ("organization_id", "name") DO NOTHING;

-- The position an assignment period has (null = no position).
ALTER TABLE "employee_assignments" ADD COLUMN "position_id" UUID;
ALTER TABLE "employee_assignments" ADD CONSTRAINT "employee_assignments_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "employee_assignments_position_id_idx" ON "employee_assignments"("position_id");

-- Existing free-text job titles that match a directory position are linked (the text itself is kept).
UPDATE "employee_assignments" a SET "position_id" = p."id"
FROM "employees" e, "positions" p
WHERE e."id" = a."employee_id" AND p."organization_id" = e."organization_id"
  AND e."job_title" IS NOT NULL AND lower(trim(e."job_title")) = lower(p."name") AND a."position_id" IS NULL;
