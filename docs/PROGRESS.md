# THE LORDS Finance OS: progress

Last updated: AI CFO targets and insights (migration 20261020090000_financial_targets)

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
| **AI CFO** (phases 1–3): tools, Claude chat, analysis, forecasts, monthly CFO report | Done. Needs `ANTHROPIC_API_KEY` in Vercel to answer; everything else works without it. See `docs/AI-CFO.md` |
| Password vault "Пароли": access register (metadata only) | Done. Decision: passwords stay in Bitwarden/1Password (Option A in `docs/SECURITY-VAULT.md`); Finance OS never stores them |

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
| `/ai-cfo` | AI CFO: key figures, rule-based risk alerts and a 3-scenario forecast (calculated, no AI); risk findings and margin opportunities with "Explain with AI"; business targets with gap analysis and "Build a plan with AI"; streaming chat with Claude that answers only through 18 read-only financial tools, shows the calculations and source links, and suggests follow-ups. Period, department, focus and attached reports as context; private chat history. Shows a configuration notice and disables the chat when no provider key is set |
| `/ai-cfo/report` | Monthly CFO report in 10 sections from the same tools, rule-based recommended actions, optional AI commentary; PDF export through the browser's print dialog |

## Database

Ten migrations, all additive. The latest, `20261020090000_financial_targets`, adds one row of business targets per organization (RLS on, no browser access). Before it, `20261019090000_ai_cfo` added the private AI chat history
(`ai_conversations`, `ai_messages` with token usage and estimated cost). Messages are append-only,
conversations cannot be deleted (only hidden), a message must belong to its conversation's user and
organization, RLS is on and the browser roles have no privileges. It changes no existing table.

## Tests (`npm test`)

| Suite | Checks | What it covers |
| --- | --- | --- |
| `test:unit` | 68 | Payroll engine; statements; number formats; XLSX/CSV; anomalies; AI alert rules; forecast engine; target gaps and what-if; margin opportunities; prioritized recommendations; follow-up parsing; cost estimates |
| `db:test` | 137 | Migrations, constraints, period locks, payroll workflow, RLS, seeds, transaction and budget rules |
| `test:sheet` | 23 | End-to-end payroll and project income/costs |
| `test:reports` | 16 | Every transaction type; drafts excluded; balanced entries; P&L; cash flow reconciliation; balance sheet; reversal; drill-down; EUR conversion; payroll integration; quarter/year totals; owner distributions; budgets; permissions |
| `test:vault` | 9 | Access register sharing, history and the secret guard |
| `test:ai` | 24 | Every AI tool's result envelope; figures equal the reports; completeness; strict input validation; no write tools; findings, opportunities and prioritized actions with the no-data guard; data-gap links; onboarding status; conversation memory; targets (permission, audit, gap, what-if); role permissions; organization isolation; chat loop with a scripted model (tool calls, errors, refusal, round and spending limits, rate limits, attachments, history); private conversations; append-only chat tables |

All integration tests run on a throwaway PGlite database; nothing is ever written to production, and the
AI tests never call the AI provider.

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

- **AI CFO needs organization-wide `reports:read`.** Department-scoped roles do not get the AI CFO yet.
- **AI CFO attachments are internal reports only.** Uploading external files (PDF, Excel) to the AI is not
  supported: they would be untrusted input with possible personal data.
- **PDF export uses the browser's print dialog** ("Save as PDF"); there is no server-generated PDF file.
- **No file uploads.** Attachments are links (for example Google Drive); there is no Supabase Storage upload.
- **Shared costs are not allocated.** Costs without a department appear only in company totals, not in
  department profitability.
- **No recurring expenses.** Each transaction is entered once; there is no template or schedule yet.
- **Department heads with department-scoped roles see no reports yet.** The session loads organization-wide
  permissions only.
- **No user-management page.** `src/lib/data/access.ts` is ready but has no UI.
- **Approved payroll months cannot be corrected in the UI.** There is no off-cycle correction run yet.

## Next steps

1. Add `ANTHROPIC_API_KEY` in Vercel (see `docs/AI-CFO.md`), then try the five prompt cards on `/ai-cfo`.
2. Users & Access page on top of `src/lib/data/access.ts`.
3. Recurring expense templates and allocation of shared costs to departments.
