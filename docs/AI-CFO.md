# AI CFO

The AI CFO answers questions about THE LORDS' finances with Claude (Anthropic API, model
`claude-opus-5-5`). It can only read figures through deterministic, permission-checked tools that use
the same report services as the pages. It never writes anything.

## Configure the provider key (server only)

Never paste the key into chat, code, the database or a `NEXT_PUBLIC_` variable.

1. In the Anthropic Console (console.anthropic.com → API Keys), create a key for this app. Set a monthly
   spend limit on the workspace in the Console too, as a second safety net.
2. In Vercel: Project → Settings → Environment Variables → add `ANTHROPIC_API_KEY` (Production, and
   Preview if you want it there), mark it **Sensitive**, save, then redeploy.
3. Locally (optional): add `ANTHROPIC_API_KEY=...` to `.env.local`, which git ignores.

Without the key, `/ai-cfo` still shows the calculated figures, risk alerts and forecast, and the monthly
report works; the chat and the AI commentary are disabled with a "not configured" notice. The page only
checks whether the key is present; it never reads it into a page or a log.

Optional limits are listed in `.env.example` (`AI_CFO_*`). The defaults are:

- **Size:** up to 16,000 output tokens per model call, 8 tool rounds per answer, 4,000 characters per
  question.
- **Rate:** 6 requests a minute and 150 a day per user.
- **Spend:** an estimated $10 a day per user and $100 a month per organization. Setting a budget to 0
  turns the AI off.

## How an answer is produced

1. `POST /api/ai-cfo/chat` performs the security checks:
   - same origin only;
   - a valid session and organization-wide `reports:read`;
   - the body is validated strictly (unknown fields are rejected);
   - the rate and spending limits are checked before the model is called.
2. The server sends Claude a fixed system prompt (cached), a context block written by the server (date,
   organization, selected period, department and focus, what the role cannot see) and the conversation.
   It sends only the tools the user's role allows.
3. Claude calls tools. Each call:
   - is checked against the tool's permission;
   - has its input validated with a strict schema (unknown fields, bad periods and ids are rejected);
   - is scoped to the user's organization (department, client and account ids from another organization
     are refused);
   - is written to the append-only `audit_logs` as `ai_cfo.tool`.

   Results go back to Claude as data. Errors go back as tool errors, so Claude can say what is missing.
4. The answer streams to the browser with the calculations that ran, their source links and completeness
   notes, and suggested follow-up questions.
5. The question and the answer are stored in `ai_messages` with token usage and estimated cost (used by
   the limits), and an `ai_cfo.answer` audit entry is written.

Server-side fallback (`fallbacks: "default"`) is on: if the model declines a request for policy reasons,
the API retries it on Anthropic's recommended fallback model. If every model declines, the partial answer
is discarded and the user sees a "declined" notice.

## Tools (`src/lib/ai/tools.ts`)

Every tool is read-only.

| Tool | Permission |
| --- | --- |
| getFinancialSummary, getProfitAndLoss, getEBITDA, getEBIT, getCashFlow, getBalanceSheet, getDepartmentProfitability, getRevenueByClient, getExpensesByCategory, getMonthlyFinancialTrends, getBudgetVariance, getFinancialAlerts, getFinancialForecast, getTargetGapAnalysis, evaluateScenario | `reports:read` |
| getPayrollSummary: totals per department only, never individual pay or wallets | `payroll:read` |
| getOwnerDistributions: no emails, approvers or payment references | `ownership:read` |
| getAccountTransactions: journal lines behind a figure; employee names are never sent | `ledger:read` |

Every result has the same envelope:

- `period` and `currency`;
- `values`;
- `sources`: links to the Finance OS pages behind the figures;
- `completeness`:
  - `complete`, `partial` or `no_data`;
  - posted and draft counts;
  - month close status;
  - whether the period is still in progress;
  - plain notes;
- `nature`: `actual`, `forecast` or `mixed`.

**Alerts** (`src/lib/ai/diagnostics.ts`) are fixed rules with thresholds. Each alert returns the figures
and the rule that fired it. They cover:

- revenue decline;
- opex or payroll growing faster than revenue;
- negative margins, margin and profit drops;
- budget shortfall or overrun;
- low runway, cash below reserve, negative cash forecast, obligations above cash;
- unprofitable departments;
- overdue or high receivables, overdue payables;
- client concentration.

**Proactive findings.** `getFinancialAlerts` also returns:

- **Department payroll spikes**, from ledger totals.
- **Opportunities to improve margins**, each with a calculated EBITDA effect:
  - expense lines back to their previous level;
  - low-margin clients brought to the company's gross margin;
  - loss-making departments brought to break-even;
  - a 10% cut of the largest cost lines.
- **A data-sufficiency check.** With no posted data in the period, nothing is flagged. With no data in the
  previous period, no period-over-period rule runs. Problems are never inferred from missing data.

The insights panel on `/ai-cfo` shows these, and "Explain with AI" asks the chat to explain them.

**Targets** (`src/lib/ai/targets.ts`, table `financial_targets`):

- **What is stored:** monthly net profit, monthly revenue, EBITDA margin % and a cash reserve in months of
  costs, one set per organization.
- **Who can change them:** only roles with `ledger:manage`, in the targets panel; each change is audited.
  The AI can read targets but not change them.
- **getTargetGapAnalysis:** compares the targets, or values given in the question, with the baseline (the
  average of the last 3 complete months). It returns the gap and the ways to close it:
  - revenue growth only;
  - fixed-cost cuts only;
  - balanced (half revenue, half costs);
  - gross-margin improvement.
- **evaluateScenario:** recalculates the baseline after percentage changes to revenue, costs and payroll.
- **Assumptions:** non-payroll cost of services varies with revenue; operating expenses and delivery
  payroll are fixed; the effective tax rate stays as it was.
- **"Build a plan with AI":** asks the chat for a plan with levers, assumptions, the calculated impact of
  each lever and KPIs.

**How the AI works a question.** The system prompt gives the AI investigation workflows (for example, for
"why did profit fall": EBITDA drivers, P&L, departments, payroll and expenses). It also sets a 7-part
answer structure:

1. Direct answer
2. Key figures
3. Drivers
4. Risks and opportunities
5. Actions
6. Expected impact
7. Next questions

Every statement is labelled as a fact, a calculation, a forecast or a recommendation, and every figure is
cited with its period and source. In follow-up turns, earlier answers include a note of the calculations
they used (tool names and inputs, never results), so the AI keeps context.

**Forecasts** (`src/lib/ai/forecast.ts`) are deterministic:

- Coverage: conservative, base and aggressive scenarios, for the next 1, 3, 6 and 12 months.
- Metrics: revenue, opex, payroll, EBITDA, EBIT, net profit, cash flow and closing cash.
- Method: the last 3 complete months as the base, the recent trend capped at ±5% a month, and budgets
  where they are set.
- Every assumption is returned with an uncertainty level.
- History: at least 3 months are required, otherwise there is no forecast.

## Security rules enforced in code

- **No SQL from the AI.** Tools are fixed functions with parameterized queries.
- **No write tools.** The AI cannot:
  - move money;
  - approve payroll;
  - post, edit or delete entries;
  - change ownership or budgets.

  Any future write action needs its own approval workflow.
- **No secrets.** The model never sees:
  - connection strings;
  - API keys;
  - the password vault;
  - payout wallets;
  - individual pay (unless the role has `salary:read`).
- **No external access.** No web browsing and no external tools are given to the model.
- **Prompt injection.** Transaction descriptions, names and attached reports are passed as data. The
  system prompt tells the model to ignore instructions inside them and to mention that it did. Even if it
  followed one, it has no write tools and only the user's own permissions.
- **Isolation.** Conversations are private to their user (RLS and server checks). Messages are
  append-only, and conversations can be hidden but not deleted.
- **Audit.** Every tool call, answer, limit block and archive is logged.

## Monthly CFO report (`/ai-cfo/report`)

The report has ten sections, built from the same tools:

1. Executive summary
2. Revenue performance
3. Cost structure
4. Department profitability
5. EBITDA and EBIT
6. Net profit
7. Cash flow
8. Financial risks
9. Budget variance
10. Recommended actions

- **Recommended actions** are rule-based, one for each alert that fired.
- **AI commentary** is optional, generated on request and labelled as AI.
- **PDF:** the "Download PDF" button opens the browser's print dialog with print styles (choose "Save as
  PDF").
