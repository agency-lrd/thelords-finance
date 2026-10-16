import { currentRange, parseRange, type PeriodKind } from "./periods"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reads ?p= (period), ?dept= and ?client= from page search params, validating ids. */
export function reportParams(params: Record<string, string | string[] | undefined>, defaultKind: PeriodKind = "month") {
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : null)
  const id = (k: string) => {
    const v = one(k)
    return v && UUID.test(v) ? v : null
  }
  const r = parseRange(one("p"), currentRange(defaultKind))
  return { range: r, period: r.key, departmentId: id("dept"), clientId: id("client") }
}
