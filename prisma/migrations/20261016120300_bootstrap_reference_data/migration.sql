-- Reference data required before first use. Contains configuration only: no employees, salaries,
-- clients or financial transactions. Every statement is idempotent.

-- ════════════════════════════════════════════════════════════════════════════
-- Currencies (more can be added as rows at any time)
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO "currencies" ("code", "name", "kind", "decimals", "symbol") VALUES
  ('USD', 'US Dollar', 'FIAT', 2, '$'),
  ('EUR', 'Euro', 'FIAT', 2, '€'),
  ('GBP', 'Pound Sterling', 'FIAT', 2, '£'),
  ('USDT', 'Tether USD', 'STABLECOIN', 6, '₮')
ON CONFLICT ("code") DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- Permission catalog (mirrored in src/lib/authz/permissions.ts; `npm run db:test` checks they match)
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO "permissions" ("key", "category", "description") VALUES
  ('organization:manage',    'administration', 'Edit company settings'),
  ('users:manage',           'administration', 'Invite users and grant or revoke roles'),
  ('audit:read',             'administration', 'Read the audit log'),
  ('period:close',           'periods',        'Close financial periods'),
  ('period:reopen',          'periods',        'Reopen closed (not locked) periods'),
  ('period:lock',            'periods',        'Permanently lock closed periods'),
  ('structure:read',         'structure',      'View departments and teams'),
  ('structure:manage',       'structure',      'Create and change departments and teams'),
  ('employee:read',          'people',         'View employee profiles'),
  ('employee:manage',        'people',         'Create and update employees and assignments'),
  ('agreement:read',         'people',         'View employment agreements'),
  ('agreement:manage',       'people',         'Create and update employment agreements'),
  ('salary:read',            'compensation',   'View salary conditions and history'),
  ('salary:manage',          'compensation',   'Propose salary changes'),
  ('salary:approve',         'compensation',   'Approve salary changes'),
  ('compensation:read',      'compensation',   'View compensation rules'),
  ('compensation:manage',    'compensation',   'Create and assign compensation rules'),
  ('kpi:read',               'kpi',            'View KPI targets and actuals'),
  ('kpi:manage',             'kpi',            'Set KPI targets and record actuals'),
  ('payroll:read',           'payroll',        'View payroll runs and payslips'),
  ('payroll:prepare',        'payroll',        'Calculate and submit payroll runs'),
  ('payroll:approve',        'payroll',        'Approve or reject payroll runs'),
  ('payroll:pay',            'payroll',        'Record payroll payments'),
  ('adjustment:request',     'payroll',        'Request bonuses and adjustments'),
  ('adjustment:approve',     'payroll',        'Approve bonuses and adjustments'),
  ('wallet:read',            'payroll',        'View employee payout wallets (masked)'),
  ('wallet:manage',          'payroll',        'Add, verify and archive payout wallets'),
  ('client:read',            'projects',       'View clients'),
  ('client:manage',          'projects',       'Create and update clients'),
  ('project:read',           'projects',       'View projects'),
  ('project:manage',         'projects',       'Create and update projects'),
  ('project_finance:read',   'projects',       'View project income and costs'),
  ('project_finance:manage', 'projects',       'Record project income and costs'),
  ('ledger:read',            'accounting',     'View chart of accounts, money accounts and journal entries'),
  ('ledger:manage',          'accounting',     'Manage accounts, categories and exchange rates'),
  ('journal:create',         'accounting',     'Create draft journal entries'),
  ('journal:post',           'accounting',     'Post and reverse journal entries'),
  ('reports:read',           'reporting',      'View P&L, Cash Flow, Balance Sheet, EBITDA and EBIT'),
  ('ownership:read',         'ownership',      'View shareholders and the cap table'),
  ('ownership:manage',       'ownership',      'Change shareholders and ownership stakes'),
  ('distribution:read',      'ownership',      'View distributions'),
  ('distribution:manage',    'ownership',      'Prepare distributions'),
  ('distribution:approve',   'ownership',      'Approve distributions')
ON CONFLICT ("key") DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- Initial company and its default roles
-- ════════════════════════════════════════════════════════════════════════════
-- Legal name, registration, tax id and country are left empty for the owners to fill in.

INSERT INTO "organizations" ("name", "base_currency", "fiscal_year_start_month", "timezone", "updated_at")
SELECT 'THE LORDS GROUP', 'USD', 1, 'UTC', now()
WHERE NOT EXISTS (SELECT 1 FROM "organizations" WHERE "name" = 'THE LORDS GROUP');

SELECT "finance_private"."create_default_roles"("id") FROM "organizations" WHERE "name" = 'THE LORDS GROUP';
