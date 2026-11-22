/**
 * Department view of the financial sheet (from November 2026): tabs per department, each with its
 * employees, recurring and one-time costs, income and profitability. Months before keep their layout.
 * Shared by server and client code.
 */
export const DEPARTMENT_VIEW_FROM = "2026-11"
export const DEPARTMENT_PARAM = "dept"
export const ALL_DEPARTMENTS = "all"

export const departmentViewActive = (monthKey: string) => monthKey >= DEPARTMENT_VIEW_FROM

/** Main directions first (by name, so existing records and ids are reused), then the rest in their order. */
const PRIORITY = [/ai\s*prod/i, /influ/i, /traffic|cpa/i, /курс|course/i]

export function orderDepartmentTabs<T extends { name: string }>(departments: T[]): T[] {
  const rank = (d: T) => {
    const i = PRIORITY.findIndex((re) => re.test(d.name))
    return i < 0 ? PRIORITY.length : i
  }
  return departments.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d)
}

/** Row heights of the sheet grid (px): header, data rows, department subtotal, grand total. */
export const GRID_ROW = 36
const GRID_HEAD = 40
const GRID_FOOT = 40

/**
 * One grid height for the whole month in the department view: sized for the largest department (plus
 * its subtotal row), never below 320 px. The page caps it at the screen height and the grid scrolls
 * inside, so switching between departments with 0, 2, 10 or 30 people never moves what is below.
 */
export function stableGridHeight(departmentIds: (string | null)[]) {
  const counts = new Map<string, number>()
  for (const id of departmentIds) counts.set(id ?? "none", (counts.get(id ?? "none") ?? 0) + 1)
  const largest = Math.max(departmentIds.length === 0 ? 0 : 1, ...counts.values())
  return Math.max(320, GRID_HEAD + (largest + 1) * GRID_ROW + GRID_FOOT + 2)
}
