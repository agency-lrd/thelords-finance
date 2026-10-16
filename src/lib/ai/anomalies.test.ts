import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { detectAnomalies } from "./anomalies"

const s = (...values: number[]) => values.map((v, i) => ({ month: i + 1, value: String(v) }))

describe("detectAnomalies", () => {
  it("flags spikes, drops and new lines; ignores small and stable ones", () => {
    const result = detectAnomalies(
      [
        { key: "software", name: "Software", series: s(1000, 1000, 1000, 2500) },
        { key: "marketing", name: "Marketing", series: s(2000, 2000, 2000, 500) },
        { key: "rent", name: "Rent", series: s(3000, 3000, 3000, 3100) },
        { key: "fees", name: "Fees", series: s(10, 10, 10, 60) },
        { key: "influencers", name: "Influencers", series: s(0, 0, 0, 4000) },
      ],
      4,
    )
    assert.deepEqual(result.map((a) => [a.key, a.reason]), [["influencers", "new"], ["software", "spike"], ["marketing", "drop"]])
    assert.equal(result.find((a) => a.key === "software")!.change, "150")
  })
  it("needs enough history", () => {
    assert.deepEqual(detectAnomalies([{ key: "x", name: "X", series: s(1, 5000) }], 2), [])
  })
})
