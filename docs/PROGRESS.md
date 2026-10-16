# THE LORDS Finance OS: progress

Last updated: 2026-10-17

## Status

| Area | Status |
| --- | --- |
| Auth, Super Admin onboarding, roles | Done. The Super Admin (agency@thelords.group) is active in production |
| Employees, departments, teams | Done |
| Financial sheet: payroll, KPI rules, bonuses, approvals, payments | Done |
| Project costs and income, department contribution | Done |
| **Phase A**: transactions, accounts, categories, ledger integration | Done |
| **Phase B**: P&L, EBITDA/EBIT, Cash Flow, Balance Sheet | Done |
| **Phase C**: monthly analytics, executive dashboard, department profitability | Done |
| **Phase D**: owners and distributions, budgets and forecasts | Done |
| **Phase E**: AI CFO preparation (tools, anomalies, disabled state) | Done. Chat is not built yet |
| Password vault "Пароли": access register (metadata only) | Done. Storing passwords waits for an approved option in `docs/SECURITY-VAULT.md` |

## How the numbers fit together

- **One source of truth.** Every report reads posted journal entries through `src/lib/reports/ledger.ts`. The
  pure builders in `src/lib/reports/statements.ts` are the only code that classifies and totals statement
  lines. The P&L, cash flow, balance sheet, analytics, dashboard, budgets and AI tools all call them, so a
  figure never differs between pages.
- **Classification by chart of accounts.** P&L sections come from the account subtype; cash flow lines come
  from the counterpart account's subtype; the balance sheet groups come from type and subtype. Nothing
  depends on transaction text.
- **What feeds the ledger automatically:**
  - Payroll approval: base salary goes to 5000/6000 and bonuses to 5050/6050, by the department's
    classification. Salary payments are posted too.
  - Project income and costs, when confirmed or paid.
  - Manual transactions: 13 types, each with a fixed double-entry template.
  - Owner distributions: approval posts Dr 3200 / Cr 2700; payment posts Dr 2700 / Cr cash.
  - Transfers, owner contributions, loans and distributions never reach revenue or EBITDA.
- **Corrections** are made by reversal. Posted entries are immutable, and closed months are locked.
- **Currency:** each record keeps its original amount, currency and exchange rate. Reports use the base
  amount (USD) saved at posting time.

## Pages

| Page | What it does |
| --- | --- |
| `/` Overview | Net profit for the period vs the monthly target; 12 KPI cards; risk alerts; trends (revenue/expenses, EBITDA, net profit, cash); profit by department; top clients; biggest expenses; upcoming payments; budget vs actual; owner distributions. Every card links to its report. Period: month, quarter or year |
| `/payroll` Financial sheet | Employee sheet plus project costs/income and department contribution (described in earlier sessions) |
| `/transactions` | Filters and search; type-aware entry form; drafts; posting (single or bulk); reversal; payment of unpaid items; bulk grid that accepts paste from Google Sheets; CSV/XLSX import (re-importing creates no duplicates); CSV/XLSX export; reconciliation against bank statements |
| `/pnl` | Statement by chart-of-accounts section with expandable lines and drill-down to journal lines. Compares with the previous period, the same period a year ago and the budget; filter by department or client; month, quarter or year |
| `/cash-flow` | Direct method, reconciled to account balances; minimum reserve, surplus or deficit; burn rate, runway, upcoming obligations, overdue items; 3-scenario forecast labelled as a forecast |
| `/balance-sheet` | Balances as of any date, with drill-down. Checks Assets = Liabilities + Equity and warns if they differ; no balancing entries are ever created |
| `/profitability` | Metrics with tooltips for the current month, previous month, a chosen period and year to date; growth; trends; department comparison |
| `/analytics` | January–December table plus quarter and year totals; any year; manual NPS, managed client budgets and custom metrics (double-click a cell); 9 charts; CSV/XLSX export |
| `/budgets` | Monthly budgets and targets by metric; Base, Conservative or Aggressive scenario; per department or project; actual, variance and variance % |
| `/owners` | Owners with effective-dated ownership and profit shares; capital, allocated, paid and outstanding amounts; distributions from an explicitly entered distributable amount, with a payout % (the rest is reinvested); approval and per-owner payment |
| `/categories` | Income and expense categories, subcategories, and the P&L line each one maps to; new P&L lines; archive |
| `/accounts`, `/departments`, `/employees` | Unchanged from earlier sessions |
| `/vault` Пароли | Credential access register: service, login URL, username, department, category, responsible employee, access level, notes, link to the item in Bitwarden/1Password. Sharing is explicit per entry (Owner and Super Admin see everything; department membership grants nothing). History of views, copies, changes and shares; refuses text that looks like a secret; browser-only password generator. **No passwords are stored**; see `docs/SECURITY-VAULT.md` |
| `/ai-cfo` | Disabled state (no provider key); deterministic month summary and anomalies; list of the tools the AI could use for your role |

## Database

Seven migrations, all applied to the finance project (`olrbibxybsytbwblroqb`); all additive. The latest is
`20261017120000_transactions_budgets`, which adds:

- the `transactions` and `budget_lines` tables, with constraints, period locks and RLS;
- 19 new chart-of-accounts lines for the requested P&L structure;
- matching categories;
- manual KPIs (Client NPS, Employee NPS, Managed client budget).

## Tests (`npm test`)

| Suite | Checks | What it covers |
| --- | --- | --- |
| `test:unit` | 33 | Payroll engine; statements (P&L, EBITDA/EBIT, margins with zero revenue, balance sheet equation and warning, cash flow with transfers excluded, distribution rounding); number formats; XLSX/CSV; anomalies |
| `db:test` | 125 | Migrations, constraints, period locks, payroll workflow, RLS, seeds, transaction and budget rules |
| `test:sheet` | 23 | End-to-end payroll and project income/costs |
| `test:reports` | 15 | Every transaction type; drafts excluded; balanced entries; P&L; cash flow reconciliation; balance sheet; reversal recalculating every report; drill-down; EUR conversion; payroll integration; month continuity; quarter/year totals; owner distribution 25/25/50 not touching EBITDA; budgets; permissions |

All integration tests run on a throwaway PGlite database; nothing is ever written to production.

## Policy choices

1. **Delivery payroll is a cost of services (confirmed by the owner, 2026-10-17).** Payroll of departments
   marked "cost of sales" (InfluLords, ViralVerse, TrafficLords, AI Production, Special Projects) is shown under
   cost of services, which lowers gross profit. Other departments' payroll is operating expense. A department's
   classification can be changed on `/departments`; the change affects new payroll postings only.
2. **No year-end closing entries.** Prior-year results appear on the balance sheet as retained earnings,
   computed from the ledger.
3. **Forecasts.** When a scenario has a budget for a month, the forecast uses it. Otherwise it uses the
   3-month average operating cash flow, adjusted by -20% / 0 / +20%.

## Known limitations

- **AI CFO chat is not built.** The tools, permissions and disabled state are ready; adding
  `ANTHROPIC_API_KEY` alone does not enable it yet.
- **No file uploads.** Attachments are links (for example Google Drive); there is no Supabase Storage upload.
- **Shared costs are not allocated.** Costs without a department appear only in company totals, not in
  department profitability.
- **No recurring expenses.** Each transaction is entered once; there is no template or schedule yet.
- **Department heads with department-scoped roles see no reports yet.** The session loads organization-wide
  permissions only.
- **No user-management page.** `src/lib/data/access.ts` is ready but has no UI.
- **Approved payroll months cannot be corrected in the UI.** There is no off-cycle correction run yet.

## Next steps

1. AI CFO chat: a server route that calls Claude with `toolsFor(user)` from `src/lib/ai/tools.ts`, runs only
   `runTool`, and answers with figures from tool results only.
2. Users & Access page on top of `src/lib/data/access.ts`.
3. Recurring expense templates and allocation of shared costs to departments.
