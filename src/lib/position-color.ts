/*
 * Position badge colors: a solid-but-tasteful background in the position's own color over the dark
 * sheet, a full-color border, and whichever text color (light or dark) reads best on that background.
 * Purely visual; client-safe (no server imports).
 */

/** The sheet's cell background the badge sits on. */
const BASE = { r: 0x0f, g: 0x0c, b: 0x10 }
/** Badge background opacity over the base: strong enough to recognise, never a neon block. */
export const BADGE_ALPHA = 0.82
export const LIGHT_TEXT = "#FFFFFF"
// Pure black keeps every mid-tone at WCAG AA (≥ 4.5:1) with the better of the two text colors.
export const DARK_TEXT = "#000000"

/** Palette tuned for the dark theme; every color keeps AA contrast as a badge. */
export const POSITION_PALETTE = ["#EC4899", "#F472B6", "#A855F7", "#8B5CF6", "#6366F1", "#3B82F6", "#22D3EE", "#14B8A6", "#22C55E", "#84CC16", "#EAB308", "#F59E0B", "#F97316", "#EF4444", "#94A3B8", "#E5E7EB"]

type Rgb = { r: number; g: number; b: number }

export function parseHex(hex: string | null | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

const channel = (v: number) => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
/** WCAG relative luminance. */
export const luminance = (c: Rgb) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
/** WCAG contrast ratio between two colors. */
export function contrast(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The color actually seen: the badge color blended over the dark cell. */
export function effectiveBackground(c: Rgb, alpha = BADGE_ALPHA): Rgb {
  const mix = (v: number, base: number) => Math.round(v * alpha + base * (1 - alpha))
  return { r: mix(c.r, BASE.r), g: mix(c.g, BASE.g), b: mix(c.b, BASE.b) }
}

/** Badge styles for a saved position color; null for the neutral default badge. */
export function positionBadgeStyle(hex: string | null | undefined): { backgroundColor: string; borderColor: string; color: string } | null {
  const c = parseHex(hex)
  if (!c) return null
  const bg = effectiveBackground(c)
  const light = contrast(bg, parseHex(LIGHT_TEXT)!)
  const dark = contrast(bg, parseHex(DARK_TEXT)!)
  return {
    backgroundColor: `rgba(${c.r}, ${c.g}, ${c.b}, ${BADGE_ALPHA})`,
    borderColor: `rgb(${c.r}, ${c.g}, ${c.b})`,
    color: light >= dark ? LIGHT_TEXT : DARK_TEXT,
  }
}
