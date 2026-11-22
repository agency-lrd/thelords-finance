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
