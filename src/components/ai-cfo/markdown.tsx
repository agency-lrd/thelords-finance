import Link from "next/link"
import type { ReactNode } from "react"

/*
 * Minimal Markdown for AI answers: headings, paragraphs, bullet and numbered lists, tables, bold,
 * italic, inline code and links. Output is React elements only (no HTML injection); links are
 * rendered only for internal Finance OS paths, anything else stays plain text.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    const k = `${key}-${i++}`
    if (t.startsWith("**") || t.startsWith("__")) out.push(<strong key={k} className="font-semibold text-foreground">{inline(t.slice(2, -2), k)}</strong>)
    else if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]">{t.slice(1, -1)}</code>)
    else if (t.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!
      const href = lm[2]
      out.push(href.startsWith("/") && !href.startsWith("//") ? <Link key={k} href={href} className="text-primary underline-offset-4 hover:underline">{lm[1]}</Link> : <span key={k}>{lm[1]}</span>)
    } else out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
const numeric = (s: string) => /^[−\-+]?[\d\s.,  ]+(%|[A-Z]{3}| ?п\.п\.| ?pp)?$/.test(s.replace(/\*\*/g, "").trim()) && /\d/.test(s)

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReactNode[] = []
  let i = 0
  let b = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = `b${b++}`
    if (!line.trim()) {
      i++
      continue
    }
    // Table: header row, separator, body rows.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]))
      blocks.push(
        <div key={key} className="my-3 overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>{head.map((h, j) => <th key={j} className="whitespace-nowrap px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{inline(h, `${key}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-t border-border/40">
                  {head.map((_, j) => <td key={j} className={`px-3 py-1.5 ${numeric(r[j] ?? "") ? "whitespace-nowrap text-right font-mono tabular-nums" : ""}`}>{inline(r[j] ?? "", `${key}r${ri}c${j}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      const cls = h[1].length <= 2 ? "mt-4 mb-2 font-display text-lg font-black uppercase italic" : "mt-3 mb-1.5 text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground"
      blocks.push(<p key={key} role="heading" aria-level={h[1].length + 1} className={cls}>{inline(h[2], key)}</p>)
      i++
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""))
      const List = ordered ? "ol" : "ul"
      blocks.push(
        <List key={key} className={`my-2 flex flex-col gap-1 pl-5 ${ordered ? "list-decimal" : "list-disc marker:text-primary"}`}>
          {items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}
        </List>,
      )
      continue
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key} className="my-3 border-border/50" />)
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^\s*([-*•]|\d+[.)])\s+|^\s*\|/.test(lines[i])) para.push(lines[i++])
    if (para.length === 0) para.push(lines[i++])
    blocks.push(<p key={key} className="my-2 leading-relaxed">{inline(para.join(" "), key)}</p>)
  }
  return <div className="text-sm text-foreground/90">{blocks}</div>
}
