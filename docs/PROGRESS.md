# THE LORDS Finance OS: progress

Last updated: 2026-10-16

## Status by phase

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Database migrations, authentication, Super Admin onboarding, departments, employees | Done (sign-in waits for the Supabase publishable key) |
| 2 | Financial sheet, salary agreements, KPI rules, bonuses, payroll calculation, approvals, payments | Done |
| 3 | Project costs and income, general expenses, transactions, department totals | Data layer partly exists (`src/lib/data/projects.ts`); no UI yet |
| 4 | P&L, EBITDA/EBIT, Cash Flow, Balance Sheet, monthly analytics | Not started; the ledger already receives payroll entries |
| 5 | Owners and investors, budgets and forecasts, AI CFO | Not started |

## What works now

- **Database**: five migrations applied to the finance Supabase project (`olrbibxybsytbwblroqb`). The fifth
  (`20261016150000_financial_sheet`) is additive only. It adds the default departments, chart of accounts,
  income and expense categories and the Profit KPI. All of these are configuration; no financial figures were added.
- **Security**: every table has row-level security, and API roles have no grants. Writes go only through the
  server, which checks permissions. The database re-checks payroll approval, journal posting, salary approval
  and adjustment approval. Wallet addresses are encrypted with AES-256-GCM (`WALLET_ENCRYPTION_KEY`) and stored
  masked; revealing a full address is permission-checked and audited. Every change is written to the
  append-only audit log.
- **Financial sheet** (`/payroll`): spreadsheet-style monthly sheet with these columns: Name, Department, FIX,
  Add Terms, Profit, Bonus, Deductions, KPI Profit, KPI Fact, Calculated, Confirm, FACT Payment, Paid,
  Outstanding, Wallet and Start Work. Extra columns: Position, Status, Team Lead, Currency, Payment
  status/date and Notes.
  - Editing happens inside the cells. Arrows, Enter, Tab and Escape navigate; ⌘C/⌘V copy and paste,
    including blocks pasted from Google Sheets. Input is accepted in either format: `$1 200,00` and
    `1,200.00`.
  - Departments are color-coded with subtotals, the header and first column are sticky, and the total
    row is magenta. You can move between months, filter by department, search, and export to CSV.
  - Changes are effective-dated: changing FIX, terms or department applies from the selected month
    onward. Earlier months keep their history.
  - Compensation terms per employee: fixed only, % of profit above KPI, % of total profit, % if KPI met,
    fixed bonus if KPI met, % of base salary, or tiered, each with an optional cap.
  - Bonuses and deductions are adjustments. They are approved immediately when the editor holds
    `adjustment:approve`; otherwise they wait for approval.
  - Confirming a row snapshots its payslip. Changing an input afterwards un-confirms it.
  - Approving the month locks the sheet and posts the payroll accrual to the ledger: delivery or
    overhead payroll by department, against payroll payable.
  - Payments can be partial or full, from a company account, with fees and FX. Each one posts to the
    ledger, and the run moves through PAYING to PAID.
  - Compensation history is available per employee.
- **Departments** (`/departments`): create, add subdepartments, rename, archive or restore, choose the
  P&L classification (cost of sales or operating expense), set the head, and manage teams and team leads.
  Each department shows its headcount and this month's payroll.
- **Company accounts** (`/accounts`): bank accounts, USDT wallets and similar, each linked to a ledger
  account. Balances come from posted entries.
- **Dashboard** (`/`): this month's payroll (calculated or approved, paid, outstanding), payroll by
  department, and items that need attention. Only real data is shown.
- **Design**: THE LORDS look with top pill navigation and the Unbounded display font. Russian by default;
  English is available through the RU/EN switch.

## Tests

`npm test` runs:

- `test:unit`: 14 tests for the payroll engine and number formatting.
- `db:test`: 111 checks of migrations, constraints, period locks, payroll workflow, RLS and seeds (PGlite).
- `test:sheet`: a 15-step end-to-end workflow on PGlite. It never connects to Supabase.

## Needed from the owner

1. **Supabase publishable key**: add `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `.env.local`. The URL is
   already there.
2. **Vercel environment variables** (Production): `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `WALLET_ENCRYPTION_KEY` (the same value as in `.env.local`)
   and `SUPER_ADMIN_EMAIL=agency@thelords.group`.
3. **Supabase Auth URL configuration**: set the Site URL to `https://thelords-finance.vercel.app` and add
   `http://localhost:3000/auth/callback` and `https://thelords-finance.vercel.app/auth/callback` to the
   redirect URLs.
4. **First sign-in**: open `/onboarding`, sign up with agency@thelords.group, confirm the email, then sign
   in. That account becomes Super Admin with the Owner role.

## Known limitations

- Users other than the Super Admin get roles through `src/lib/data/access.ts`, which has no page yet.
  Accounts must exist in Supabase Auth first.
- Department heads with department-scoped roles do not see the sheet yet; the session loads
  organization-wide permissions only.
- Mixed currencies: KPI and bonus amounts are entered in the employee's salary currency. Sheet totals
  include only rows in the base currency (USD) and show how many rows were left out.
- Corrections to an approved month need an off-cycle correction run, which has no UI yet.
- Hourly and daily pay can be calculated, but the sheet has no column for worked hours or days yet.

## Next step

Phase 3: build pages for project income and project costs, grouped by department, on top of
`src/lib/data/projects.ts`. Post recognized income and costs to the ledger; the payroll postings in
`src/lib/data/sheet.ts` (`postJournal` in `src/lib/data/ledger.ts`) show the pattern. Then add the
department profitability view, with revenue, direct costs, payroll, shared costs and contribution margin.
