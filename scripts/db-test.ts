/**
 * Database test suite. Applies every migration in prisma/migrations to a throwaway in-memory
 * Postgres (PGlite) and verifies financial constraints, period locks, payroll workflow,
 * authorization triggers and row level security. Never connects to Supabase.
 *
 * All fixtures are fictional placeholders. Usage: npm run db:test
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { PGlite } from "@electric-sql/pglite"

import { DEFAULT_ROLE_KEYS, PERMISSIONS } from "../src/lib/authz/permissions"

const MIGRATIONS_DIR = path.resolve("prisma/migrations")

const db = new PGlite()
let passed = 0
let failed = 0

function report(ok: boolean, name: string, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` ${detail}` : ""}`)
}

async function ok(name: string, sql: string) {
  try {
    await db.exec(sql)
    report(true, name)
  } catch (error) {
    report(false, name, `-> expected success, got: ${(error as Error).message}`)
  }
}

async function rejects(name: string, sql: string, pattern: RegExp) {
  try {
    await db.exec(`BEGIN; ${sql}; ROLLBACK;`)
    report(false, name, "-> expected rejection")
  } catch (error) {
    await db.exec("ROLLBACK").catch(() => {})
    const message = (error as Error).message
    report(pattern.test(message), name, pattern.test(message) ? "" : `-> wrong error: ${message}`)
  }
}

async function equals(name: string, sql: string, expected: unknown) {
  try {
    const { rows } = await db.query<{ v: unknown }>(sql)
    const actual = rows[0]?.v
    const same = JSON.stringify(actual) === JSON.stringify(expected)
    report(same, name, same ? "" : `-> expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  } catch (error) {
    report(false, name, `-> ${(error as Error).message}`)
  }
}

/** Counts rows visible to an API role for a given JWT subject (null = no JWT). */
async function visible(role: "anon" | "authenticated", sub: string | null, table: string): Promise<number | string> {
  try {
    await db.exec("BEGIN")
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [sub ? JSON.stringify({ sub, role }) : ""])
    await db.exec(`SET LOCAL ROLE ${role}`)
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)
    return rows[0].n
  } catch (error) {
    return (error as Error).message
  } finally {
    await db.exec("ROLLBACK").catch(() => {})
  }
}

// Fictional ids
const id = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`
const ORG = id(0xa0), OTHER_ORG = id(0xa1)
const P1 = id(0xb1), P2 = id(0xb2)
const CASH = id(0xc1), REV = id(0xc2), HDR = id(0xc3), BANK2 = id(0xc4), FA = id(0xc5)
const D1 = id(0xd1), D2 = id(0xd2)
const EMP_A = id(0xe1), EMP_B = id(0xe2), WALLET_A = id(0xe3), WALLET_B = id(0xe4)
const KPI = id(0xf1), SH1 = id(0xf2), SH2 = id(0xf3)
const U = {
  superAdmin: id(0x101), owner: id(0x102), cfo: id(0x103), financeManager: id(0x104), deptHead: id(0x105),
  hr: id(0x106), employeeA: id(0x107), readOnly: id(0x108), outsider: id(0x109), suspendedCfo: id(0x10a),
}

async function grant(user: string, roleKey: string, scope: string | null = null) {
  await db.exec(`INSERT INTO user_role_assignments (organization_id, user_id, role_id, scope_department_id)
    SELECT '${ORG}', '${user}', id, ${scope ? `'${scope}'` : "NULL"} FROM roles WHERE organization_id = '${ORG}' AND key = '${roleKey}'`)
}

async function main() {
  console.log("migrations")
  // Reproduce Supabase: API roles exist and objects created by "postgres" grant them everything by default.
  await db.exec(`CREATE ROLE anon NOLOGIN NOINHERIT; CREATE ROLE authenticated NOLOGIN NOINHERIT;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;`)
  const migrations = readdirSync(MIGRATIONS_DIR).filter((d) => /^\d+_/.test(d)).sort()
  for (const [index, dir] of migrations.entries()) {
    try {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"))
      report(true, `apply ${dir}`)
    } catch (error) {
      report(false, `apply ${dir}`, `-> ${(error as Error).message}`)
      throw new Error("Migration failed; aborting")
    }
    if (index === 0) {
      // Even if a later migration failed, the tables must already be closed to the API roles.
      await equals("after first migration: no API-role table privileges", `SELECT count(*)::int v FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`, 0)
      await equals("after first migration: RLS on every table", `SELECT count(*) FILTER (WHERE NOT rowsecurity)::int v FROM pg_tables WHERE schemaname = 'public'`, 0)
    }
  }
  await equals("no API-role privileges on any public table, sequence or function", `SELECT (
      (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated'))
    + (SELECT count(*) FROM information_schema.role_usage_grants WHERE object_schema = 'public' AND grantee IN ('anon', 'authenticated'))
    + (SELECT count(*) FROM information_schema.role_routine_grants WHERE routine_schema = 'public' AND grantee IN ('anon', 'authenticated'))
    )::int v`, 0)

  console.log("\nbootstrap data")
  await equals("one company: THE LORDS GROUP in USD", `SELECT json_agg(json_build_array(name, base_currency))::text v FROM organizations`, '[["THE LORDS GROUP", "USD"]]')
  await equals("currencies USD, EUR, GBP, USDT", `SELECT string_agg(code || ':' || decimals, ',' ORDER BY code) v FROM currencies`, "EUR:2,GBP:2,USD:2,USDT:6")
  await equals("7 default roles", `SELECT string_agg(key, ',' ORDER BY key) v FROM roles`, [...DEFAULT_ROLE_KEYS].sort().join(","))
  await equals("permission catalog matches src/lib/authz/permissions.ts", `SELECT string_agg(key, ',' ORDER BY key) v FROM permissions`, [...PERMISSIONS].sort().join(","))
  await equals("Owner holds every permission", `SELECT count(*)::int v FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'OWNER'`, PERMISSIONS.length)
  await equals("CFO cannot approve distributions", `SELECT count(*)::int v FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'CFO' AND rp.permission_key = 'distribution:approve'`, 0)
  await equals("HR cannot approve salaries", `SELECT count(*)::int v FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'HR' AND rp.permission_key = 'salary:approve'`, 0)
  await equals("Finance Manager cannot approve payroll", `SELECT count(*)::int v FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'FINANCE_MANAGER' AND rp.permission_key = 'payroll:approve'`, 0)
  await equals("no employees or financial records seeded", `SELECT ((SELECT count(*) FROM employees) + (SELECT count(*) FROM journal_entries) + (SELECT count(*) FROM salary_conditions) + (SELECT count(*) FROM clients))::int v`, 0)

  // ── Fixtures: a separate test organization ──
  await db.exec(`
    INSERT INTO organizations (id, name, base_currency, updated_at) VALUES ('${ORG}', 'Test Co', 'USD', now()), ('${OTHER_ORG}', 'Other Co', 'USD', now());
    SELECT finance_private.create_default_roles('${ORG}');
    SELECT finance_private.create_default_roles('${OTHER_ORG}');
    INSERT INTO financial_periods (id, organization_id, year, month, fiscal_year, start_date, end_date, updated_at) VALUES
      ('${P1}', '${ORG}', 2026, 1, 2026, '2026-01-01', '2026-01-31', now()),
      ('${P2}', '${ORG}', 2026, 2, 2026, '2026-02-01', '2026-02-28', now());
    INSERT INTO ledger_accounts (id, organization_id, code, name, type, subtype, normal_balance, cash_flow_activity, is_postable, updated_at) VALUES
      ('${CASH}', '${ORG}', '1000', 'Bank', 'ASSET', 'CASH', 'DEBIT', 'NONE', true, now()),
      ('${REV}', '${ORG}', '4000', 'Revenue', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT', 'OPERATING', true, now()),
      ('${HDR}', '${ORG}', '4', 'Income (header)', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT', 'OPERATING', false, now()),
      ('${BANK2}', '${ORG}', '1010', 'Bank 2', 'ASSET', 'CASH', 'DEBIT', 'NONE', true, now());
    INSERT INTO financial_accounts (id, organization_id, ledger_account_id, type, name, currency, updated_at) VALUES ('${FA}', '${ORG}', '${BANK2}', 'BANK', 'Bank', 'USD', now());
    INSERT INTO app_users (id, email, status, is_super_admin, updated_at) VALUES
      ('${U.superAdmin}', 'sa@example.test', 'ACTIVE', true, now()),
      ('${U.owner}', 'owner@example.test', 'ACTIVE', false, now()),
      ('${U.cfo}', 'cfo@example.test', 'ACTIVE', false, now()),
      ('${U.financeManager}', 'fm@example.test', 'ACTIVE', false, now()),
      ('${U.deptHead}', 'head@example.test', 'ACTIVE', false, now()),
      ('${U.hr}', 'hr@example.test', 'ACTIVE', false, now()),
      ('${U.employeeA}', 'a@example.test', 'ACTIVE', false, now()),
      ('${U.readOnly}', 'ro@example.test', 'ACTIVE', false, now()),
      ('${U.outsider}', 'x@example.test', 'ACTIVE', false, now()),
      ('${U.suspendedCfo}', 'old@example.test', 'SUSPENDED', false, now());
    INSERT INTO departments (id, organization_id, code, name, updated_at) VALUES ('${D1}', '${ORG}', 'D1', 'Delivery', now()), ('${D2}', '${ORG}', 'D2', 'Sales', now());
    INSERT INTO employees (id, organization_id, user_id, employee_number, first_name, last_name, hire_date, updated_at) VALUES
      ('${EMP_A}', '${ORG}', '${U.employeeA}', 'T-1', 'Test', 'Alpha', '2026-01-01', now()),
      ('${EMP_B}', '${ORG}', NULL, 'T-2', 'Test', 'Beta', '2026-01-01', now());
    INSERT INTO employee_assignments (employee_id, department_id, valid_from) VALUES ('${EMP_B}', '${D2}', '2020-01-01');
    INSERT INTO payout_wallets (id, employee_id, type, label, currency, masked_identifier, updated_at) VALUES
      ('${WALLET_A}', '${EMP_A}', 'CRYPTO_WALLET', 'USDT', 'USDT', '•••• 0000', now()),
      ('${WALLET_B}', '${EMP_B}', 'BANK_ACCOUNT', 'Main', 'USD', '•••• 1111', now());
    INSERT INTO kpi_definitions (id, organization_id, code, name, unit, updated_at) VALUES ('${KPI}', '${ORG}', 'K', 'Deals', 'COUNT', now());
  `)
  for (const [user, role] of [[U.owner, "OWNER"], [U.cfo, "CFO"], [U.financeManager, "FINANCE_MANAGER"], [U.hr, "HR"],
    [U.employeeA, "EMPLOYEE"], [U.readOnly, "READ_ONLY"], [U.suspendedCfo, "CFO"]] as const) {
    await grant(user, role)
  }
  await grant(U.deptHead, "DEPARTMENT_HEAD", D1)

  console.log("\nvalue constraints")
  await rejects("unknown currency code", `INSERT INTO organizations (name, base_currency, updated_at) VALUES ('x', 'usd', now())`, /foreign key/)
  await rejects("invalid currency definition", `INSERT INTO currencies (code, name, kind, decimals) VALUES ('us', 'x', 'FIAT', 2)`, /currencies_code_chk/)
  await rejects("month 13", `INSERT INTO financial_periods (organization_id, year, month, fiscal_year, start_date, end_date, updated_at) VALUES ('${ORG}', 2026, 13, 2026, '2026-03-01', '2026-03-31', now())`, /month_chk/)
  await rejects("negative salary", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from) VALUES ('${EMP_A}', 'MONTHLY', -1, 'USD', '2026-01-01')`, /amount_chk/)
  await rejects("hourly pay without hours", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from) VALUES ('${EMP_A}', 'HOURLY', 10, 'USD', '2020-01-01')`, /hours_chk/)
  await rejects("KPI scope key mismatch", `INSERT INTO kpi_targets (organization_id, kpi_definition_id, period_id, scope, scope_key, target_value, updated_at) VALUES ('${ORG}', '${KPI}', '${P1}', 'EMPLOYEE', 'ORG', 1, now())`, /scope_chk/)
  await rejects("KPI employee scope without employee", `INSERT INTO kpi_targets (organization_id, kpi_definition_id, period_id, scope, scope_key, target_value, updated_at) VALUES ('${ORG}', '${KPI}', '${P1}', 'EMPLOYEE', 'EMPLOYEE:', 1, now())`, /scope_chk/)
  await ok("KPI employee target", `INSERT INTO kpi_targets (organization_id, kpi_definition_id, period_id, scope, scope_key, employee_id, target_value, updated_at) VALUES ('${ORG}', '${KPI}', '${P1}', 'EMPLOYEE', 'EMPLOYEE:${EMP_A}', '${EMP_A}', 10, now())`)
  await rejects("duplicate KPI target", `INSERT INTO kpi_targets (organization_id, kpi_definition_id, period_id, scope, scope_key, employee_id, target_value, updated_at) VALUES ('${ORG}', '${KPI}', '${P1}', 'EMPLOYEE', 'EMPLOYEE:${EMP_A}', '${EMP_A}', 11, now())`, /duplicate key/)
  await rejects("payroll net != gross - deductions", `INSERT INTO payroll_runs (id, organization_id, period_id, currency, updated_at) VALUES ('${id(0x998)}', '${ORG}', '${P1}', 'USD', now());
    INSERT INTO payroll_items (payroll_run_id, employee_id, currency, gross_amount, deductions_amount, net_amount, updated_at) VALUES ('${id(0x998)}', '${EMP_A}', 'USD', 100, 10, 95, now())`, /net_chk/)
  await rejects("journal line with debit and credit", `INSERT INTO journal_entries (id, organization_id, period_id, entry_number, entry_date, description, updated_at) VALUES ('${id(0x997)}', '${ORG}', '${P1}', 997, '2026-01-10', 'x', now());
    INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, debit, credit) VALUES ('${id(0x997)}', 1, '${CASH}', 5, 5)`, /amounts_chk/)
  await rejects("foreign-currency line without FX rate", `INSERT INTO journal_entries (id, organization_id, period_id, entry_number, entry_date, description, updated_at) VALUES ('${id(0x996)}', '${ORG}', '${P1}', 996, '2026-01-10', 'x', now());
    INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, debit, transaction_currency, transaction_amount) VALUES ('${id(0x996)}', 1, '${CASH}', 5, 'EUR', 6)`, /fx_chk/)

  console.log("\neffective-dated history and precision")
  await ok("salary Jan-Mar (USD)", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from, valid_to) VALUES ('${EMP_A}', 'MONTHLY', 1000.5, 'USD', '2026-01-01', '2026-04-01')`)
  await ok("salary from Apr (USDT, adjacent)", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from) VALUES ('${EMP_A}', 'MONTHLY', 1234.567891, 'USDT', '2026-04-01')`)
  await equals("USDT amount stored exactly (6 decimals)", `SELECT base_amount::text v FROM salary_conditions WHERE currency = 'USDT'`, "1234.56789100")
  await rejects("overlapping salary", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from, valid_to) VALUES ('${EMP_A}', 'MONTHLY', 1, 'USD', '2026-03-15', '2026-05-01')`, /Overlapping/)
  await ok("salary for B", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from) VALUES ('${EMP_B}', 'MONTHLY', 2000, 'EUR', '2026-01-01')`)
  await ok("assignment A: 60% D1", `INSERT INTO employee_assignments (employee_id, department_id, allocation_rate, is_primary, valid_from) VALUES ('${EMP_A}', '${D1}', 0.6, true, '2020-01-01')`)
  await rejects("second primary assignment", `INSERT INTO employee_assignments (employee_id, department_id, allocation_rate, is_primary, valid_from) VALUES ('${EMP_A}', '${D2}', 0.2, true, '2026-02-01')`, /primary/)
  await rejects("allocation over 100%", `INSERT INTO employee_assignments (employee_id, department_id, allocation_rate, is_primary, valid_from) VALUES ('${EMP_A}', '${D2}', 0.5, false, '2026-02-01')`, /exceed/)
  await ok("shareholders 60% + 40%", `INSERT INTO shareholders (id, organization_id, type, name, user_id, updated_at) VALUES ('${SH1}', '${ORG}', 'INDIVIDUAL', 'Holder A', '${U.owner}', now()), ('${SH2}', '${ORG}', 'INDIVIDUAL', 'Holder B', NULL, now());
    INSERT INTO ownership_stakes (shareholder_id, ownership_share, currency, valid_from) VALUES ('${SH1}', 0.6, 'USD', '2026-01-01'), ('${SH2}', 0.4, 'USD', '2026-01-01')`)
  await rejects("ownership over 100%", `INSERT INTO ownership_stakes (shareholder_id, share_class, ownership_share, currency, valid_from) VALUES ('${SH2}', 'PREFERRED', 0.01, 'USD', '2026-06-01')`, /exceed/)

  console.log("\ngeneral ledger")
  const JE = id(0x11), RV = id(0x13)
  await ok("draft entry with unbalanced lines", `INSERT INTO journal_entries (id, organization_id, period_id, entry_number, entry_date, description, updated_at) VALUES ('${JE}', '${ORG}', '${P1}', 1, '2026-01-15', 'Invoice', now());
    INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, debit) VALUES ('${JE}', 1, '${CASH}', 100.0001);
    INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, credit) VALUES ('${JE}', 2, '${REV}', 100)`)
  await rejects("post unbalanced entry", `UPDATE journal_entries SET status = 'POSTED', posted_at = now() WHERE id = '${JE}'`, /not balanced/)
  await rejects("line on header account", `INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, credit) VALUES ('${JE}', 3, '${HDR}', 1)`, /postable/)
  await rejects("entry date outside period", `INSERT INTO journal_entries (organization_id, period_id, entry_number, entry_date, description, updated_at) VALUES ('${ORG}', '${P1}', 2, '2026-02-15', 'x', now())`, /outside/)
  await rejects("post by user without journal:post (HR)", `UPDATE journal_lines SET debit = 100 WHERE journal_entry_id = '${JE}' AND line_number = 1;
    UPDATE journal_entries SET status = 'POSTED', posted_at = now(), posted_by_id = '${U.hr}' WHERE id = '${JE}'`, /lacks permission journal:post/)
  await ok("balance and post (Finance Manager)", `UPDATE journal_lines SET debit = 100 WHERE journal_entry_id = '${JE}' AND line_number = 1;
    UPDATE journal_entries SET status = 'POSTED', posted_at = now(), posted_by_id = '${U.financeManager}' WHERE id = '${JE}'`)
  await rejects("edit posted line", `UPDATE journal_lines SET debit = 1 WHERE journal_entry_id = '${JE}' AND line_number = 1`, /immutable/)
  await rejects("add line to posted entry", `INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, credit) VALUES ('${JE}', 9, '${REV}', 1)`, /cannot be added/)
  await rejects("edit posted entry", `UPDATE journal_entries SET description = 'changed' WHERE id = '${JE}'`, /immutable/)
  await rejects("delete posted entry", `DELETE FROM journal_entries WHERE id = '${JE}'`, /only drafts/)

  console.log("\nperiod close")
  await ok("draft entry in January", `INSERT INTO journal_entries (id, organization_id, period_id, entry_number, entry_date, description, updated_at) VALUES ('${id(0x12)}', '${ORG}', '${P1}', 3, '2026-01-20', 'draft', now())`)
  await rejects("close period with draft entry", `UPDATE financial_periods SET status = 'CLOSED', closed_at = now() WHERE id = '${P1}'`, /draft journal/)
  await rejects("close period by user without period:close (HR)", `DELETE FROM journal_entries WHERE id = '${id(0x12)}';
    UPDATE financial_periods SET status = 'CLOSED', closed_at = now(), closed_by_id = '${U.hr}' WHERE id = '${P1}'`, /lacks permission period:close/)
  await ok("delete draft, close January (CFO)", `DELETE FROM journal_entries WHERE id = '${id(0x12)}';
    UPDATE financial_periods SET status = 'CLOSED', closed_at = now(), closed_by_id = '${U.cfo}' WHERE id = '${P1}'`)
  await rejects("new entry in closed period", `INSERT INTO journal_entries (organization_id, period_id, entry_number, entry_date, description, updated_at) VALUES ('${ORG}', '${P1}', 4, '2026-01-21', 'late', now())`, /CLOSED/)
  await rejects("KPI actual in closed period", `INSERT INTO kpi_actuals (organization_id, kpi_definition_id, period_id, scope, scope_key, actual_value, updated_at) VALUES ('${ORG}', '${KPI}', '${P1}', 'ORGANIZATION', 'ORG', 1, now())`, /CLOSED/)
  await ok("reverse January entry in February", `INSERT INTO journal_entries (id, organization_id, period_id, entry_number, entry_date, description, source, reverses_entry_id, updated_at) VALUES ('${RV}', '${ORG}', '${P2}', 5, '2026-02-01', 'Reversal', 'REVERSAL', '${JE}', now());
    INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, credit) VALUES ('${RV}', 1, '${CASH}', 100);
    INSERT INTO journal_lines (journal_entry_id, line_number, ledger_account_id, debit) VALUES ('${RV}', 2, '${REV}', 100);
    UPDATE journal_entries SET status = 'POSTED', posted_at = now() WHERE id = '${RV}';
    UPDATE journal_entries SET status = 'REVERSED' WHERE id = '${JE}'`)
  await rejects("lock period without period:lock (Finance Manager)", `UPDATE financial_periods SET status = 'LOCKED', closed_by_id = '${U.financeManager}' WHERE id = '${P1}'`, /lacks permission period:lock/)
  await ok("lock January permanently (CFO)", `UPDATE financial_periods SET status = 'LOCKED', closed_by_id = '${U.cfo}' WHERE id = '${P1}'`)
  await rejects("reopen locked period", `UPDATE financial_periods SET status = 'OPEN' WHERE id = '${P1}'`, /LOCKED/)
  await rejects("delete period", `DELETE FROM financial_periods WHERE id = '${P2}'`, /append-only/)

  console.log("\npayroll workflow")
  const RUN = id(0x21), ITEM_A = id(0x22), ITEM_B = id(0x26), ADJ = id(0x24)
  await ok("draft run with payslips for A (D1) and B (D2)", `INSERT INTO payroll_runs (id, organization_id, period_id, currency, updated_at) VALUES ('${RUN}', '${ORG}', '${P2}', 'USD', now());
    INSERT INTO payroll_items (id, payroll_run_id, employee_id, department_id, currency, gross_amount, deductions_amount, net_amount, updated_at) VALUES
      ('${ITEM_A}', '${RUN}', '${EMP_A}', '${D1}', 'USD', 1100, 100, 1000, now()),
      ('${ITEM_B}', '${RUN}', '${EMP_B}', '${D2}', 'USD', 2000, 0, 2000, now());
    INSERT INTO payroll_item_lines (payroll_item_id, line_type, description, amount) VALUES ('${ITEM_A}', 'BASE_SALARY', 'Base', 1100)`)
  await rejects("create run as APPROVED", `INSERT INTO payroll_runs (organization_id, period_id, sequence, currency, status, updated_at) VALUES ('${ORG}', '${P2}', 2, 'USD', 'APPROVED', now())`, /DRAFT/)
  await rejects("skip DRAFT -> APPROVED", `UPDATE payroll_runs SET status = 'APPROVED' WHERE id = '${RUN}'`, /Invalid payroll status/)
  await ok("pending bonus for A", `INSERT INTO payroll_adjustments (id, organization_id, employee_id, period_id, type, amount, currency, reason, requested_by_id, updated_at) VALUES ('${ADJ}', '${ORG}', '${EMP_A}', '${P2}', 'BONUS', 50, 'USD', 'test', '${U.deptHead}', now())`)
  await rejects("unapproved adjustment on payslip", `INSERT INTO payroll_item_lines (payroll_item_id, line_type, description, amount, adjustment_id) VALUES ('${ITEM_A}', 'BONUS', 'Bonus', 50, '${ADJ}')`, /not approved/)
  await rejects("adjustment approved by HR (no adjustment:approve)", `UPDATE payroll_adjustments SET status = 'APPROVED', decided_at = now(), approved_by_id = '${U.hr}' WHERE id = '${ADJ}'`, /lacks permission adjustment:approve/)
  await ok("calculate and submit", `UPDATE payroll_runs SET status = 'CALCULATED' WHERE id = '${RUN}'; UPDATE payroll_runs SET status = 'SUBMITTED' WHERE id = '${RUN}'`)
  await rejects("approve without approval record", `UPDATE payroll_runs SET status = 'APPROVED' WHERE id = '${RUN}'`, /no recorded approval/)
  await rejects("approval by Finance Manager (no payroll:approve)", `INSERT INTO payroll_approvals (payroll_run_id, step, approver_id, decision) VALUES ('${RUN}', 1, '${U.financeManager}', 'APPROVED')`, /lacks permission payroll:approve/)
  await rejects("approval by suspended CFO", `INSERT INTO payroll_approvals (payroll_run_id, step, approver_id, decision) VALUES ('${RUN}', 1, '${U.suspendedCfo}', 'APPROVED')`, /lacks permission payroll:approve/)
  await rejects("payment before approval", `INSERT INTO payroll_payments (payroll_item_id, payout_wallet_id, financial_account_id, method, amount, currency, base_amount, updated_at) VALUES ('${ITEM_A}', '${WALLET_A}', '${FA}', 'CRYPTO', 1000, 'USDT', 1000, now())`, /not in an approved/)
  await ok("CFO approves", `INSERT INTO payroll_approvals (payroll_run_id, step, approver_id, decision) VALUES ('${RUN}', 1, '${U.cfo}', 'APPROVED');
    UPDATE payroll_runs SET status = 'APPROVED' WHERE id = '${RUN}'`)
  await rejects("edit payslip after approval", `UPDATE payroll_items SET notes = 'x' WHERE id = '${ITEM_A}'`, /no longer be changed/)
  await rejects("edit approval record", `UPDATE payroll_approvals SET comment = 'x'`, /append-only/)
  await rejects("pay A into B's wallet", `INSERT INTO payroll_payments (payroll_item_id, payout_wallet_id, financial_account_id, method, amount, currency, base_amount, updated_at) VALUES ('${ITEM_A}', '${WALLET_B}', '${FA}', 'BANK_TRANSFER', 1000, 'USD', 1000, now())`, /does not belong/)
  await ok("close February, then pay in USDT (settlement allowed)", `UPDATE financial_periods SET status = 'CLOSED', closed_at = now() WHERE id = '${P2}';
    INSERT INTO payroll_payments (payroll_item_id, payout_wallet_id, financial_account_id, method, status, amount, currency, base_amount, paid_at, updated_at) VALUES ('${ITEM_A}', '${WALLET_A}', '${FA}', 'CRYPTO', 'CONFIRMED', 1000.123456, 'USDT', 1000.12, now(), now());
    UPDATE payroll_runs SET status = 'PAYING' WHERE id = '${RUN}'; UPDATE payroll_runs SET status = 'PAID' WHERE id = '${RUN}'`)
  await rejects("change run notes in closed period", `UPDATE payroll_runs SET notes = 'x' WHERE id = '${RUN}'`, /CLOSED|cannot be changed/)
  await rejects("delete payment", `DELETE FROM payroll_payments`, /append-only/)

  console.log("\nauthorization rules")
  await rejects("Department Head without department scope", `INSERT INTO user_role_assignments (organization_id, user_id, role_id) SELECT '${ORG}', '${U.outsider}', id FROM roles WHERE organization_id = '${ORG}' AND key = 'DEPARTMENT_HEAD'`, /require scope/)
  await rejects("role from another organization", `INSERT INTO user_role_assignments (organization_id, user_id, role_id) SELECT '${ORG}', '${U.outsider}', id FROM roles WHERE organization_id = '${OTHER_ORG}' AND key = 'CFO'`, /does not belong/)
  await rejects("delete role grant (revoke via valid_to)", `DELETE FROM user_role_assignments`, /append-only/)
  await rejects("salary approved by HR (no salary:approve)", `INSERT INTO salary_conditions (employee_id, pay_basis, base_amount, currency, valid_from, approved_by_id) VALUES ('${EMP_B}', 'MONTHLY', 1, 'USD', '2030-01-01', '${U.hr}')`, /lacks permission salary:approve/)

  console.log("\naudit log")
  await ok("insert audit row", `INSERT INTO audit_logs (organization_id, actor_type, action, entity_type) VALUES ('${ORG}', 'SYSTEM', 'test.event', 'test')`)
  await rejects("update audit row", `UPDATE audit_logs SET action = 'x'`, /append-only/)
  await rejects("delete audit row", `DELETE FROM audit_logs`, /append-only/)
  await rejects("truncate audit log", `TRUNCATE audit_logs`, /append-only/)

  // ── Row level security ──
  const { rows: tableRows } = await db.query<{ t: string }>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)
  const tables = tableRows.map((r) => r.t)

  console.log("\nanonymous access (Supabase anon key)")
  await equals("every table has RLS enabled", `SELECT count(*) FILTER (WHERE NOT rowsecurity)::int v FROM pg_tables WHERE schemaname = 'public'`, 0)
  await equals("no policy grants anything to anon", `SELECT count(*)::int v FROM pg_policies WHERE schemaname = 'public' AND ('anon' = ANY (roles) OR 'public' = ANY (roles))`, 0)
  const anonLeaks = []
  for (const t of tables) {
    const r = await visible("anon", null, t)
    if (typeof r === "number" || !/permission denied/.test(r)) anonLeaks.push(`${t}: ${r}`)
  }
  report(anonLeaks.length === 0, `anon denied on all ${tables.length} tables`, anonLeaks.join("; "))
  const anonPrivate = await (async () => {
    try {
      await db.exec("BEGIN; SET LOCAL ROLE anon")
      await db.query(`SELECT "finance_private"."is_super_admin"()`)
      return "call succeeded"
    } catch (error) {
      return (error as Error).message
    } finally {
      await db.exec("ROLLBACK").catch(() => {})
    }
  })()
  report(/permission denied/.test(anonPrivate), "anon cannot call authorization helpers", /permission denied/.test(anonPrivate) ? "" : `-> ${anonPrivate}`)

  console.log("\nsigned-in users today (no table privileges granted yet)")
  const authLeaks = []
  for (const t of tables) {
    const r = await visible("authenticated", U.superAdmin, t)
    if (typeof r === "number" || !/permission denied/.test(r)) authLeaks.push(`${t}: ${r}`)
  }
  report(authLeaks.length === 0, `authenticated denied on all ${tables.length} tables (even super admin)`, authLeaks.join("; "))

  console.log("\nRLS policies once SELECT is granted to authenticated (simulated, rolled back per query)")
  await db.exec("GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated")
  const matrix: [string, string, Record<keyof typeof U, number>][] = [
    ["employees", "people", { superAdmin: 2, owner: 2, cfo: 2, financeManager: 2, deptHead: 1, hr: 2, employeeA: 1, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["salary_conditions", "salary history", { superAdmin: 3, owner: 3, cfo: 3, financeManager: 3, deptHead: 0, hr: 3, employeeA: 2, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["payroll_items", "payslips", { superAdmin: 2, owner: 2, cfo: 2, financeManager: 2, deptHead: 1, hr: 2, employeeA: 1, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["payroll_item_lines", "payslip lines", { superAdmin: 1, owner: 1, cfo: 1, financeManager: 1, deptHead: 1, hr: 1, employeeA: 1, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["payroll_payments", "payments", { superAdmin: 1, owner: 1, cfo: 1, financeManager: 1, deptHead: 1, hr: 1, employeeA: 1, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["payout_wallets", "wallets", { superAdmin: 2, owner: 2, cfo: 2, financeManager: 2, deptHead: 0, hr: 2, employeeA: 1, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["journal_entries", "ledger", { superAdmin: 2, owner: 2, cfo: 2, financeManager: 2, deptHead: 0, hr: 0, employeeA: 0, readOnly: 2, outsider: 0, suspendedCfo: 0 }],
    ["journal_lines", "ledger lines", { superAdmin: 4, owner: 4, cfo: 4, financeManager: 4, deptHead: 0, hr: 0, employeeA: 0, readOnly: 4, outsider: 0, suspendedCfo: 0 }],
    ["ownership_stakes", "cap table", { superAdmin: 2, owner: 2, cfo: 2, financeManager: 0, deptHead: 0, hr: 0, employeeA: 0, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["audit_logs", "audit log", { superAdmin: 1, owner: 1, cfo: 1, financeManager: 0, deptHead: 0, hr: 0, employeeA: 0, readOnly: 0, outsider: 0, suspendedCfo: 0 }],
    ["organizations", "companies", { superAdmin: 3, owner: 1, cfo: 1, financeManager: 1, deptHead: 1, hr: 1, employeeA: 1, readOnly: 1, outsider: 0, suspendedCfo: 0 }],
    ["kpi_targets", "KPIs", { superAdmin: 1, owner: 1, cfo: 1, financeManager: 1, deptHead: 1, hr: 1, employeeA: 1, readOnly: 1, outsider: 0, suspendedCfo: 0 }],
  ]
  for (const [table, label, expected] of matrix) {
    const mismatches: string[] = []
    for (const [who, uid] of Object.entries(U) as [keyof typeof U, string][]) {
      const got = await visible("authenticated", uid, table)
      if (got !== expected[who]) mismatches.push(`${who}: expected ${expected[who]}, got ${got}`)
    }
    report(mismatches.length === 0, `${label} (${table}) visibility per role`, mismatches.join("; "))
  }
  const noJwt = await visible("authenticated", null, "employees")
  report(noJwt === 0, "authenticated role without a JWT subject sees nothing", noJwt === 0 ? "" : `-> ${noJwt}`)
  const write = await (async () => {
    try {
      await db.exec("BEGIN")
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.superAdmin })])
      await db.exec("SET LOCAL ROLE authenticated")
      await db.exec(`UPDATE salary_conditions SET base_amount = 1`)
      return "update succeeded"
    } catch (error) {
      return (error as Error).message
    } finally {
      await db.exec("ROLLBACK").catch(() => {})
    }
  })()
  report(/permission denied/.test(write), "API users cannot write even with SELECT granted", /permission denied/.test(write) ? "" : `-> ${write}`)
  await db.exec("REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM authenticated")

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .catch((error: Error) => {
    console.error(error.message)
    failed++
  })
  .finally(async () => {
    await db.close()
    process.exit(failed ? 1 : 0)
  })
