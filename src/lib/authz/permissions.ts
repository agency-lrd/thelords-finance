/**
 * Permission catalog. Must match the "permissions" rows seeded in
 * prisma/migrations/*_bootstrap_reference_data (verified by `npm run db:test`).
 */
export const PERMISSIONS = [
  "organization:manage",
  "users:manage",
  "audit:read",
  "period:close",
  "period:reopen",
  "period:lock",
  "structure:read",
  "structure:manage",
  "employee:read",
  "employee:manage",
  "agreement:read",
  "agreement:manage",
  "salary:read",
  "salary:manage",
  "salary:approve",
  "compensation:read",
  "compensation:manage",
  "kpi:read",
  "kpi:manage",
  "payroll:read",
  "payroll:prepare",
  "payroll:approve",
  "payroll:pay",
  "adjustment:request",
  "adjustment:approve",
  "wallet:read",
  "wallet:manage",
  "client:read",
  "client:manage",
  "project:read",
  "project:manage",
  "project_finance:read",
  "project_finance:manage",
  "ledger:read",
  "ledger:manage",
  "journal:create",
  "journal:post",
  "reports:read",
  "ownership:read",
  "ownership:manage",
  "distribution:read",
  "distribution:manage",
  "distribution:approve",
  "vault:manage",
  "vault:audit",
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Default per-organization roles created by finance_private.create_default_roles(). */
export const DEFAULT_ROLE_KEYS = [
  "OWNER",
  "CFO",
  "FINANCE_MANAGER",
  "DEPARTMENT_HEAD",
  "HR",
  "EMPLOYEE",
  "READ_ONLY",
] as const

export type DefaultRoleKey = (typeof DEFAULT_ROLE_KEYS)[number]
