-- The four main departments of the financial sheet from November 2026, in their fixed order:
-- Influence, AI Production, Crypto Marketing, Traffic Affiliate. Additive only: a nullable position on
-- existing department records (matched by their stable codes); no department is created, renamed,
-- merged or deleted, and no employee or record is reassigned.
ALTER TABLE "departments" ADD COLUMN "main_order" SMALLINT;
ALTER TABLE "departments" ADD CONSTRAINT "departments_main_order_check" CHECK ("main_order" IS NULL OR "main_order" BETWEEN 1 AND 20);

UPDATE "departments" d SET "main_order" = m."main_order"
FROM (VALUES ('INFLULORDS', 1), ('AI-PRODUCTION', 2), ('MARKETING', 3), ('TRAFFICLORDS', 4)) AS m("code", "main_order")
WHERE d."code" = m."code" AND d."main_order" IS NULL;
