-- AI CFO: private chat history with token usage and estimated cost (for spending limits).
-- Additive only. The assistant is read-only: nothing here touches financial tables.

-- CreateEnum
CREATE TYPE "ai_message_role" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "ai_message_status" AS ENUM ('COMPLETE', 'TRUNCATED', 'REFUSED', 'ERROR');

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL DEFAULT 'ru',
    "context" JSONB,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ai_message_role" NOT NULL,
    "status" "ai_message_status" NOT NULL DEFAULT 'COMPLETE',
    "content" TEXT NOT NULL,
    "tools" JSONB,
    "follow_ups" JSONB,
    "model" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_conversations_organization_id_user_id_updated_at_idx" ON "ai_conversations"("organization_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_idx" ON "ai_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_messages_organization_id_created_at_idx" ON "ai_messages"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_messages_user_id_created_at_idx" ON "ai_messages"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

ALTER TABLE "ai_conversations"
  ADD CONSTRAINT "ai_conversations_title_chk" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "ai_conversations_locale_chk" CHECK ("locale" IN ('ru', 'en'));

ALTER TABLE "ai_messages"
  ADD CONSTRAINT "ai_messages_content_chk" CHECK (length("content") <= 200000),
  ADD CONSTRAINT "ai_messages_usage_chk" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_write_tokens" >= 0 AND "cost_usd" >= 0);

-- A message belongs to the same organization and user as its conversation.
CREATE FUNCTION "ai_message_owner_trg"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ai_conversations" c
    WHERE c."id" = NEW."conversation_id" AND c."organization_id" = NEW."organization_id" AND c."user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'ai_messages: organization or user does not match the conversation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ai_messages_owner" BEFORE INSERT ON "ai_messages"
  FOR EACH ROW EXECUTE FUNCTION "ai_message_owner_trg"();

-- History and usage records are append-only (spending limits are computed from them).
CREATE TRIGGER "ai_messages_append_only" BEFORE UPDATE OR DELETE ON "ai_messages"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();
-- Conversations are archived, never deleted.
CREATE TRIGGER "ai_conversations_no_delete" BEFORE DELETE ON "ai_conversations"
  FOR EACH ROW EXECUTE FUNCTION "fin_append_only_trg"();

-- ─── Row level security: only the server writes; a user can read only their own chats ───

ALTER TABLE "ai_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_messages" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "ai_conversations", "ai_messages" FROM anon, authenticated;
  END IF;
END;
$$;

CREATE POLICY "ai_conversations_read_own" ON "ai_conversations" FOR SELECT TO authenticated
  USING ("user_id" = (SELECT "finance_private"."current_user_id"()));
CREATE POLICY "ai_messages_read_own" ON "ai_messages" FOR SELECT TO authenticated
  USING ("user_id" = (SELECT "finance_private"."current_user_id"()));
