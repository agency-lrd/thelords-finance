-- Project income and costs on the financial workspace: a comment on every row and the team credited
-- with income. Additive only: two nullable columns, one nullable foreign key and an index.

ALTER TABLE "project_income" ADD COLUMN "notes" TEXT,
ADD COLUMN "team_id" UUID;

ALTER TABLE "project_costs" ADD COLUMN "notes" TEXT;

ALTER TABLE "project_income" ADD CONSTRAINT "project_income_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "project_income_team_id_idx" ON "project_income"("team_id");
