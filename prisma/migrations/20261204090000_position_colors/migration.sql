-- A display color per position (directory record, not per employee). Additive only; null = default
-- neutral color. Purely visual: no payroll, department or accounting data depends on it.
ALTER TABLE "positions" ADD COLUMN "color" VARCHAR(7);
ALTER TABLE "positions" ADD CONSTRAINT "positions_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$');
