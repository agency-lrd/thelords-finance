import { config } from "dotenv"
import { defineConfig } from "prisma/config"

// Prisma 7 does not load env files itself; mirror Next.js and read .env.local.
config({ path: ".env.local", quiet: true })

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // CLI connection (migrate, introspect). Migrations need a session-mode connection,
    // so prefer DIRECT_URL (port 5432) and fall back to the transaction pooler.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
})
