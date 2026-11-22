import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DARK_TEXT, POSITION_PALETTE, LIGHT_TEXT, contrast, effectiveBackground, parseHex, positionBadgeStyle } from "./position-color"

const ratio = (hex: string) => {
  const style = positionBadgeStyle(hex)!
  return contrast(effectiveBackground(parseHex(hex)!), parseHex(style.color)!)
}

describe("position badge colors", () => {
  it("no saved color gives the neutral badge; invalid values too", () => {
    assert.equal(positionBadgeStyle(null), null)
    assert.equal(positionBadgeStyle("pink"), null)
  })

  it("picks light text on dark/saturated colors and dark text on light ones", () => {
    assert.equal(positionBadgeStyle("#3B82F6")!.color, LIGHT_TEXT, "blue: light text")
    assert.equal(positionBadgeStyle("#8B5CF6")!.color, LIGHT_TEXT, "purple: light text")
    assert.equal(positionBadgeStyle("#22D3EE")!.color, DARK_TEXT, "cyan: dark text")
    assert.equal(positionBadgeStyle("#E5E7EB")!.color, DARK_TEXT, "near-white: dark text")
    assert.equal(positionBadgeStyle("#1E1B4B")!.color, LIGHT_TEXT, "very dark: light text")
  })

  it("every palette color and every sampled HEX keeps WCAG AA contrast (4.5:1)", () => {
    for (const hex of POSITION_PALETTE) assert.ok(ratio(hex) >= 4.5, `${hex}: ${ratio(hex).toFixed(2)}`)
    const steps = [0, 34, 68, 102, 136, 170, 204, 238, 255]
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
      assert.ok(ratio(hex) >= 4.5, `${hex}: ${ratio(hex).toFixed(2)}`)
    }
  })

  it("uses the saved color for background and border", () => {
    const s = positionBadgeStyle("#ec4899")!
    assert.equal(s.borderColor, "rgb(236, 72, 153)")
    assert.match(s.backgroundColor, /^rgba\(236, 72, 153, 0\.8\d\)$/)
  })
})
