/** Minimal SVG charts in THE LORDS style. Values are decimal strings or numbers; no chart library. */
import { cn } from "cn"

type Point = { label: string; value: number }

const fmtShort = (v: number) => {
  const a = Math.abs(v)
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 1000 ? `${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k` : `${Math.round(a)}`
  return v < 0 ? `−${s}` : s
}

/** Bars around a zero line (negative values go down, in red). */
export function BarChart({ data, height = 160, className, unit = "" }: { data: Point[]; height?: number; className?: string; unit?: string }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)))
  const hasNegative = data.some((d) => d.value < 0)
  const zero = hasNegative ? height / 2 : height - 18
  const scale = (hasNegative ? height / 2 - 14 : height - 32) / max
  const w = 100 / Math.max(1, data.length)
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className={cn("h-40 w-full overflow-visible", className)} role="img">
      <line x1="0" x2="100" y1={zero} y2={zero} stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
      {data.map((d, i) => {
        const h = Math.abs(d.value) * scale
        return (
          <g key={d.label + i}>
            <title>{`${d.label}: ${d.value.toLocaleString("ru-RU")}${unit}`}</title>
            <rect x={i * w + w * 0.2} width={w * 0.6} y={d.value >= 0 ? zero - h : zero} height={Math.max(h, d.value === 0 ? 0 : 0.5)} rx="0.6" className={d.value >= 0 ? "fill-primary" : "fill-red-500/80"} />
          </g>
        )
      })}
    </svg>
  )
}

/** Line with dots; labels are rendered by the caller (keeps SVG text from stretching). */
export function LineChart({ data, height = 120, className }: { data: Point[]; height?: number; className?: string }) {
  const values = data.map((d) => d.value)
  const min = Math.min(0, ...values)
  const max = Math.max(1, ...values)
  const y = (v: number) => height - 8 - ((v - min) / (max - min || 1)) * (height - 16)
  const x = (i: number) => (data.length <= 1 ? 50 : (i / (data.length - 1)) * 100)
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.value)}`).join(" ")
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className={cn("h-32 w-full overflow-visible", className)} role="img">
      {min < 0 && <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />}
      <path d={path} fill="none" className="stroke-primary" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.value)} r="1.2" className="fill-primary">
          <title>{`${d.label}: ${d.value.toLocaleString("ru-RU")}`}</title>
        </circle>
      ))}
    </svg>
  )
}

/** Axis labels under a chart, evenly spaced. */
export function ChartLabels({ labels }: { labels: string[] }) {
  return (
    <div className="mt-1 grid text-center text-[10px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
      {labels.map((l, i) => <span key={i} className="truncate">{l}</span>)}
    </div>
  )
}

/** Horizontal share bars (cost structure, department split). */
export function ShareBars({ data, format }: { data: Point[]; format: (v: number) => string }) {
  const total = data.reduce((a, d) => a + Math.abs(d.value), 0) || 1
  return (
    <div className="flex flex-col gap-3">
      {data.map((d) => (
        <div key={d.label} className="flex flex-col gap-1">
          <div className="flex justify-between gap-3 text-sm">
            <span className="truncate">{d.label}</span>
            <span className="shrink-0 font-mono text-muted-foreground">{format(d.value)} · {Math.round((Math.abs(d.value) / total) * 100)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/10">
            <div className={cn("h-full rounded-full", d.value < 0 ? "bg-red-500/80" : "bg-primary")} style={{ width: `${(Math.abs(d.value) / total) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export { fmtShort }
