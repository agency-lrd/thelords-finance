/**
 * Transaction import: fields, settings, limits and result shapes shared by the server pipeline and the
 * import wizard. No server dependencies.
 */

export const IMPORT_FIELDS = [
  "date",
  "description",
  "amount",
  "currency",
  "type",
  "department",
  "category",
  "client",
  "project",
  "account",
  "notes",
  "counterparty",
  "counterAccount",
  "fxRate",
  "paymentStatus",
  "dueDate",
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

/** Shown first in the mapping step (the rest are under "more fields"). */
export const MAIN_FIELDS: ImportField[] = ["date", "description", "amount", "currency", "type", "department", "category", "client", "project", "account", "notes"]

export const LIMITS = {
  maxBytes: 4_000_000,
  maxRows: 5_000,
  maxColumns: 60,
  maxCellChars: 1_000,
  /** Rows created per database transaction when confirming. */
  chunkSize: 100,
}

export type DateFormat = "auto" | "DMY" | "MDY" | "YMD"
export type DecimalSeparator = "auto" | "." | ","

export type ImportSettings = {
  /** 0-based index of the header row; rows above it are ignored. */
  headerRow: number
  /** Column index for each mapped field. */
  mapping: Partial<Record<ImportField, number>>
  dateFormat: DateFormat
  decimal: DecimalSeparator
  /** Used when the cell is empty or the column is not mapped. */
  defaults: { type: string | null; currency: string | null; account: string | null; category: string | null }
}

export type IssueCode =
  | "date_required"
  | "date_invalid"
  | "date_out_of_range"
  | "period_closed"
  | "amount_required"
  | "amount_invalid"
  | "amount_zero"
  | "description_required"
  | "description_truncated"
  | "type_required"
  | "type_unknown"
  | "type_manual_only"
  | "currency_unknown"
  | "fx_missing"
  | "account_required"
  | "account_not_found"
  | "counter_account_required"
  | "counter_account_not_found"
  | "same_accounts"
  | "category_required"
  | "category_not_found"
  | "category_kind"
  | "category_payroll"
  | "department_not_found"
  | "client_not_found"
  | "project_not_found"
  | "owner_not_found"
  | "unpaid_not_allowed"
  | "due_date_invalid"
  | "negative_amount"
  | "formula_text"
  | "duplicate_in_file"
  | "already_imported"
  | "possible_duplicate"

export type Issue = { code: IssueCode; field?: ImportField; value?: string }

/** Issues that only warn; every other issue makes the row invalid. */
export const WARNING_CODES: IssueCode[] = ["description_truncated", "negative_amount", "formula_text", "possible_duplicate"]

export type RowPreview = {
  date: string
  description: string
  amount: string
  currency: string
  type: string
  account: string | null
  category: string | null
  department: string | null
  client: string | null
  project: string | null
}

export type RowCheck = {
  /** Row number in the file (1-based, as shown in Excel). */
  row: number
  status: "ok" | "warning" | "error" | "duplicate"
  /** Suggested inclusion: valid rows yes; invalid and duplicate rows no. */
  include: boolean
  issues: Issue[]
  preview: RowPreview | null
}

export type ImportSummary = {
  rows: number
  valid: number
  warnings: number
  errors: number
  duplicates: number
  /** Amounts by currency of the rows that would be imported, split so that transfers, owner money and loans are never counted as income. */
  totals: { currency: string; income: string; expense: string; other: string; count: number }[]
}

export type ImportFileErrorCode = "empty" | "too_large" | "unsupported" | "legacy_xls" | "corrupt" | "too_many_rows" | "too_many_columns" | "no_rows"
