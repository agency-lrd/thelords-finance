-- Department color for the financial sheet. Additive: one nullable column.

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "color" VARCHAR(20);


ALTER TABLE "departments" ADD CONSTRAINT "departments_color_chk" CHECK ("color" IS NULL OR "color" ~ '^[a-z]{3,20}$');
