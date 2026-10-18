-- Recurring KPI targets for the monthly payroll rollover. Additive: one column with a default (existing targets stay month-only).

-- AlterTable
ALTER TABLE "kpi_targets" ADD COLUMN     "recurring" BOOLEAN NOT NULL DEFAULT false;

