// Department colors (like the colored Department column of the original sheet). The key is stored on
// the department (departments.color); departments without a color get one by position.
export const PALETTE = [
  { key: "pink", chip: "bg-pink-500/85 text-white", name: "bg-pink-500/15", bar: "bg-pink-500" },
  { key: "amber", chip: "bg-amber-400/90 text-black", name: "bg-amber-400/15", bar: "bg-amber-400" },
  { key: "violet", chip: "bg-violet-600/90 text-white", name: "bg-violet-600/20", bar: "bg-violet-500" },
  { key: "sky", chip: "bg-sky-400/85 text-black", name: "bg-sky-400/15", bar: "bg-sky-400" },
  { key: "rose", chip: "bg-rose-300/90 text-black", name: "bg-rose-300/15", bar: "bg-rose-300" },
  { key: "emerald", chip: "bg-emerald-500/85 text-black", name: "bg-emerald-500/15", bar: "bg-emerald-500" },
  { key: "orange", chip: "bg-orange-500/85 text-black", name: "bg-orange-500/15", bar: "bg-orange-500" },
  { key: "fuchsia", chip: "bg-fuchsia-600/85 text-white", name: "bg-fuchsia-600/15", bar: "bg-fuchsia-500" },
  { key: "teal", chip: "bg-teal-400/85 text-black", name: "bg-teal-400/15", bar: "bg-teal-400" },
]
export const NO_DEPT = { key: "none", chip: "bg-muted text-muted-foreground", name: "", bar: "bg-muted-foreground" }

export function paletteFor(color: string | null | undefined, index: number) {
  return PALETTE.find((p) => p.key === color) ?? PALETTE[index % PALETTE.length]
}
