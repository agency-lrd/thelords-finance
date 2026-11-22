/**
 * Department view of the financial sheet (from November 2026): tabs per department, each with its
 * employees, recurring and one-time costs, income and profitability. Months before keep their layout.
 * Shared by server and client code.
 */
export const DEPARTMENT_VIEW_FROM = "2026-11"
export const DEPARTMENT_PARAM = "dept"
export const ALL_DEPARTMENTS = "all"

export const departmentViewActive = (monthKey: string) => monthKey >= DEPARTMENT_VIEW_FROM

/**
 * The financial sheet's department tabs from November 2026: exactly the departments marked main
 * (Influence, AI Production, Crypto Marketing, Traffic Affiliate), in their fixed order. Every other
 * function is a position, team or category inside one of them. Falls back to name matching only if
 * no department is marked (an organization without the migration's codes).
 */
export function mainDepartmentTabs<T extends { name: string; mainOrder?: number | null; archived?: boolean }>(departments: T[]): T[] {
  const main = departments.filter((d) => d.mainOrder != null && !d.archived).sort((a, b) => a.mainOrder! - b.mainOrder!)
  return main.length ? main : orderDepartmentTabs(departments.filter((d) => !d.archived)).slice(0, 4)
}

/** Main directions first (by name, so existing records and ids are reused), then the rest in their order. */
const PRIORITY = [/influ/i, /ai\s*prod/i, /crypto|marketing/i, /traffic|cpa/i]

export function orderDepartmentTabs<T extends { name: string }>(departments: T[]): T[] {
  const rank = (d: T) => {
    const i = PRIORITY.findIndex((re) => re.test(d.name))
    return i < 0 ? PRIORITY.length : i
  }
  return departments.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d)
}

/** Row heights of the sheet grid (px): header, data rows, department subtotal, grand total. */
export const GRID_ROW = 44
const GRID_SUBTOTAL = 32
const GRID_HEAD = 40
const GRID_FOOT = 40

/**
 * One grid height for the whole month in the department view, sized for the tallest view: the largest
 * department (its rows + subtotal) or the combined "Общий" view (all rows + one subtotal per
 * department), never below 320 px. The page caps it at the screen height and the grid scrolls inside,
 * so switching between "Общий" and departments with 0, 2, 10 or 30 people never moves what is below.
 */
export function stableGridHeight(departmentIds: (string | null)[], options: { combined?: boolean } = {}) {
  const counts = new Map<string, number>()
  for (const id of departmentIds) counts.set(id ?? "none", (counts.get(id ?? "none") ?? 0) + 1)
  const largestDepartment = departmentIds.length === 0 ? 0 : Math.max(...counts.values()) * GRID_ROW + GRID_SUBTOTAL
  const combined = options.combined ? departmentIds.length * GRID_ROW + counts.size * GRID_SUBTOTAL : 0
  return Math.max(320, GRID_HEAD + Math.max(largestDepartment, combined) + GRID_FOOT + 2)
}
