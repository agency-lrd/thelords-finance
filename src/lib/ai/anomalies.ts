/**
 * Anomaly detection inputs for the AI CFO: flags ledger lines whose latest month deviates strongly
 * from their own recent history. Pure and deterministic; the AI only explains what this returns.
 */
import Decimal from "decimal.js"

export type SeriesPoint = { month: number; value: string }
export type Anomaly = { key: string; name: string; month: number; value: string; baseline: string; change: string | null; reason: "spike" | "drop" | "new" }

/**
 * baseline = average of the previous `window` months (zeros included). A month is flagged when it is
 * at least `minChange` (default 50%) away from the baseline and the absolute difference exceeds
 * `minAmount`, or when a line appears that had no history at all.
 */
export function detectAnomalies(
  lines: { key: string; name: string; series: SeriesPoint[] }[],
  month: number,
  { window = 3, minChange = 0.5, minAmount = 100 }: { window?: number; minChange?: number; minAmount?: number } = {},
): Anomaly[] {
  const out: Anomaly[] = []
  for (const line of lines) {
    const value = new Decimal(line.series.find((p) => p.month === month)?.value ?? 0)
    const history = Array.from({ length: window }, (_, i) => new Decimal(line.series.find((p) => p.month === month - 1 - i)?.value ?? 0))
    if (month - window < 1) continue
    const baseline = history.reduce((a, v) => a.add(v), new Decimal(0)).div(window)
    const diff = value.sub(baseline)
    if (diff.abs().lt(minAmount)) continue
    if (baseline.isZero()) {
      if (!value.isZero()) out.push({ key: line.key, name: line.name, month, value: value.toString(), baseline: "0", change: null, reason: "new" })
      continue
    }
    const change = diff.div(baseline.abs())
    if (change.abs().gte(minChange)) {
      out.push({ key: line.key, name: line.name, month, value: value.toString(), baseline: baseline.toDecimalPlaces(2).toString(), change: change.mul(100).toDecimalPlaces(1).toString(), reason: diff.isPositive() ? "spike" : "drop" })
    }
  }
  return out.sort((a, b) => Math.abs(Number(b.value) - Number(b.baseline)) - Math.abs(Number(a.value) - Number(a.baseline)))
}
