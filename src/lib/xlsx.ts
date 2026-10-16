/**
 * Minimal XLSX read/write (first sheet, text and numbers) for imports and exports. Runs in the browser
 * and in tests. Built on fflate's zip; no formulas or styles.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function column(index: number) {
  let n = index + 1
  let s = ""
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Writes rows to a single-sheet workbook. Cells that look like plain numbers are stored as numbers. */
export function writeXlsx(rows: (string | number | null)[][], sheetName = "Sheet1"): Uint8Array {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === "") return ""
          const ref = `${column(c)}${r + 1}`
          const text = String(value)
          if (typeof value === "number" || /^-?\d+(\.\d+)?$/.test(text)) return `<c r="${ref}"><v>${text}</v></c>`
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
        })
        .join("")
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join("")
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
    ),
  }
  return zipSync(files)
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

/** Reads the first worksheet as rows of strings (shared strings, inline strings and numbers). */
export function readXlsx(data: Uint8Array): string[][] {
  const files = unzipSync(data)
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : null)
  const shared: string[] = []
  const sst = text("xl/sharedStrings.xml")
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(unesc((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")))
    }
  }
  const sheetName = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0]
  const sheet = sheetName ? text(sheetName) : null
  if (!sheet) return []
  const rows: string[][] = []
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = []
    for (const cell of rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = /r="([A-Z]+)\d+"/.exec(cell)?.[1] ?? column(row.length)
      let index = 0
      for (const ch of ref) index = index * 26 + (ch.charCodeAt(0) - 64)
      const type = /t="(\w+)"/.exec(cell)?.[1]
      const v = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1]
      let value = ""
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? ""
      else if (type === "inlineStr") value = unesc((cell.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""))
      else if (v !== undefined) value = unesc(v)
      row[index - 1] = value
    }
    rows.push(Array.from(row, (c) => c ?? ""))
  }
  return rows
}

/** Parses CSV (comma or semicolon, quoted fields) into rows. */
export function readCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "")
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ""
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : firstLine.includes("\t") ? "\t" : ","
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim()))
}

export function toCsv(rows: (string | number | null)[][]) {
  return "﻿" + rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n")
}
