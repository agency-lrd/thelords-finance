/**
 * The owner-facing cash register: each "kind" of money movement (client payment, salary, owner
 * distribution, investor loan, ...) maps to one accounting template of the transaction engine, so a
 * movement is always one transaction posted once, whichever screen it was entered on.
 *
 * What a kind never does:
 *   - client advertising budgets (pass-through) are held for the client, never revenue;
 *   - owner/investor money (contributions, distributions, capital returns, loans) never touches profit;
 *   - internal transfers are neither income nor expense;
 *   - salaries are paid against approved payslips (the sheet), never as a second salary expense.
 * Shared by server and client code (no server-only imports).
 */
import type { TransactionType } from "@/generated/prisma/enums"

export type Direction = "IN" | "OUT" | "TRANSFER"
export type KindGroup = "clients" | "operations" | "payroll" | "owners" | "investors" | "financing" | "transfers"

export type KindSpec = {
  direction: Direction
  group: KindGroup
  /** Accounting template; null for salary payments (recorded against payslips, see recordPayment). */
  type: TransactionType | null
  /** Ledger account codes overriding the template's default debit or credit side. */
  debitCode?: string
  creditCode?: string
  /** What the form must ask for. */
  needs: { client?: boolean; shareholder?: boolean; category?: "revenue" | "expense" | "otherIncome"; counterAccount?: boolean; payslip?: boolean }
  /** Default category code when none is chosen. */
  categoryCode?: string
  refund?: "IN" | "OUT"
  /** Affects profit (P&L) when posted. */
  pnl: boolean
}

const KIND_DEFS = {
  // Money in
  CLIENT_PAYMENT: { direction: "IN", group: "clients", type: "REVENUE", needs: { client: true, category: "revenue" }, pnl: true },
  CLIENT_BUDGET: { direction: "IN", group: "clients", type: "LOAN_RECEIVED", creditCode: "2500", needs: { client: true }, pnl: false },
  OTHER_INCOME: { direction: "IN", group: "operations", type: "REVENUE", needs: { category: "otherIncome" }, categoryCode: "OTHER-INCOME", pnl: true },
  REFUND_IN: { direction: "IN", group: "operations", type: "REFUND", refund: "IN", needs: { category: "expense" }, pnl: true },
  OWNER_CONTRIBUTION: { direction: "IN", group: "owners", type: "OWNER_CONTRIBUTION", needs: { shareholder: true }, pnl: false },
  INVESTOR_CONTRIBUTION: { direction: "IN", group: "investors", type: "OWNER_CONTRIBUTION", needs: { shareholder: true }, pnl: false },
  INVESTOR_LOAN: { direction: "IN", group: "investors", type: "LOAN_RECEIVED", creditCode: "2650", needs: { shareholder: true }, pnl: false },
  LOAN_RECEIVED: { direction: "IN", group: "financing", type: "LOAN_RECEIVED", creditCode: "2650", needs: {}, pnl: false },
  // Money out
  SALARY: { direction: "OUT", group: "payroll", type: null, needs: { payslip: true }, pnl: false },
  CONTRACTOR: { direction: "OUT", group: "operations", type: "OPERATING_EXPENSE", needs: { category: "expense" }, categoryCode: "CONTRACTORS", pnl: true },
  SUPPLIER: { direction: "OUT", group: "operations", type: "OPERATING_EXPENSE", needs: { category: "expense" }, pnl: true },
  OPERATING: { direction: "OUT", group: "operations", type: "OPERATING_EXPENSE", needs: { category: "expense" }, pnl: true },
  CLIENT_BUDGET_SPEND: { direction: "OUT", group: "clients", type: "LOAN_REPAYMENT", debitCode: "2500", needs: { client: true }, pnl: false },
  REFUND_OUT: { direction: "OUT", group: "clients", type: "REFUND", refund: "OUT", needs: { client: true, category: "revenue" }, pnl: true },
  TAX: { direction: "OUT", group: "operations", type: "TAX_PAYMENT", needs: {}, pnl: true },
  OWNER_DISTRIBUTION: { direction: "OUT", group: "owners", type: "OWNER_WITHDRAWAL", needs: { shareholder: true }, pnl: false },
  INVESTOR_DISTRIBUTION: { direction: "OUT", group: "investors", type: "OWNER_WITHDRAWAL", needs: { shareholder: true }, pnl: false },
  INVESTOR_CAPITAL_RETURN: { direction: "OUT", group: "investors", type: "OWNER_WITHDRAWAL", debitCode: "3000", needs: { shareholder: true }, pnl: false },
  INVESTOR_LOAN_REPAYMENT: { direction: "OUT", group: "investors", type: "LOAN_REPAYMENT", debitCode: "2650", needs: { shareholder: true }, pnl: false },
  LOAN_REPAYMENT: { direction: "OUT", group: "financing", type: "LOAN_REPAYMENT", debitCode: "2650", needs: {}, pnl: false },
  OTHER_OUT: { direction: "OUT", group: "operations", type: "OPERATING_EXPENSE", needs: { category: "expense" }, categoryCode: "OTHER-OPEX", pnl: true },
  // Between own accounts
  TRANSFER: { direction: "TRANSFER", group: "transfers", type: "INTERNAL_TRANSFER", needs: { counterAccount: true }, pnl: false },
} as const satisfies Record<string, KindSpec>

export type Kind = keyof typeof KIND_DEFS
export const KINDS: Record<Kind, KindSpec> = KIND_DEFS
export const KIND_KEYS = Object.keys(KINDS) as Kind[]

/** Kinds shown and entered on the Owners page (the same transactions as in Transactions). */
export const OWNER_KINDS: Kind[] = ["OWNER_CONTRIBUTION", "OWNER_DISTRIBUTION", "INVESTOR_CONTRIBUTION", "INVESTOR_LOAN", "INVESTOR_DISTRIBUTION", "INVESTOR_CAPITAL_RETURN", "INVESTOR_LOAN_REPAYMENT"]

export const isKind = (value: unknown): value is Kind => typeof value === "string" && value in KINDS

/** The kind a transaction is shown as: its stored kind, otherwise one derived from its accounting type. */
export function kindOf(t: { kind: string | null; type: TransactionType; direction: string | null; shareholderId: string | null; clientId: string | null }): Kind {
  if (isKind(t.kind)) return t.kind
  switch (t.type) {
    case "REVENUE": return t.clientId ? "CLIENT_PAYMENT" : "OTHER_INCOME"
    case "OPERATING_EXPENSE": return "OPERATING"
    case "PAYROLL": return "SALARY"
    case "INTERNAL_TRANSFER": return "TRANSFER"
    case "OWNER_CONTRIBUTION": return "OWNER_CONTRIBUTION"
    case "OWNER_WITHDRAWAL": return "OWNER_DISTRIBUTION"
    case "LOAN_RECEIVED": return "LOAN_RECEIVED"
    case "LOAN_REPAYMENT": return "LOAN_REPAYMENT"
    case "TAX_PAYMENT": return "TAX"
    case "REFUND": return t.direction === "OUT" ? "REFUND_OUT" : "REFUND_IN"
    default: return "OTHER_OUT"
  }
}

export const KIND_LABELS: Record<"ru" | "en", Record<Kind, string>> = {
  ru: {
    CLIENT_PAYMENT: "Оплата от клиента",
    CLIENT_BUDGET: "Рекламный бюджет клиента (транзит)",
    OTHER_INCOME: "Прочий доход",
    REFUND_IN: "Возврат нам",
    OWNER_CONTRIBUTION: "Взнос собственника в капитал",
    INVESTOR_CONTRIBUTION: "Взнос инвестора",
    INVESTOR_LOAN: "Заём от инвестора",
    LOAN_RECEIVED: "Получен заём",
    SALARY: "Выплата зарплаты / бонуса",
    CONTRACTOR: "Оплата подрядчику",
    SUPPLIER: "Оплата поставщику",
    OPERATING: "Операционный расход",
    CLIENT_BUDGET_SPEND: "Расход бюджета клиента (транзит)",
    REFUND_OUT: "Возврат клиенту",
    TAX: "Налоги",
    OWNER_DISTRIBUTION: "Выплата собственнику",
    INVESTOR_DISTRIBUTION: "Выплата прибыли инвестору",
    INVESTOR_CAPITAL_RETURN: "Возврат капитала инвестору",
    INVESTOR_LOAN_REPAYMENT: "Погашение займа инвестора",
    LOAN_REPAYMENT: "Погашение основного долга по займу",
    OTHER_OUT: "Прочий платёж",
    TRANSFER: "Перевод между своими счетами",
  },
  en: {
    CLIENT_PAYMENT: "Client payment",
    CLIENT_BUDGET: "Client ad budget (pass-through)",
    OTHER_INCOME: "Other income",
    REFUND_IN: "Refund to us",
    OWNER_CONTRIBUTION: "Owner capital contribution",
    INVESTOR_CONTRIBUTION: "Investor contribution",
    INVESTOR_LOAN: "Investor loan received",
    LOAN_RECEIVED: "Loan received",
    SALARY: "Salary / bonus payment",
    CONTRACTOR: "Contractor payment",
    SUPPLIER: "Supplier payment",
    OPERATING: "Operating expense",
    CLIENT_BUDGET_SPEND: "Client budget spent (pass-through)",
    REFUND_OUT: "Refund to client",
    TAX: "Taxes",
    OWNER_DISTRIBUTION: "Owner distribution",
    INVESTOR_DISTRIBUTION: "Investor profit distribution",
    INVESTOR_CAPITAL_RETURN: "Investor capital return",
    INVESTOR_LOAN_REPAYMENT: "Investor loan repayment",
    LOAN_REPAYMENT: "Loan principal repayment",
    OTHER_OUT: "Other payment",
    TRANSFER: "Transfer between own accounts",
  },
}
