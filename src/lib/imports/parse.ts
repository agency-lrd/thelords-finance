/**
 * Safe reading of uploaded CSV and XLSX files into rows of text cells. Pure (no I/O).
 *  - Size, row, column and cell limits; empty and unsupported files are rejected with a reason.
 *  - XLSX: only the first worksheet's stored values are read; formulas are never evaluated, and the
 *    archive is checked for oversized entries (zip bombs) before anything is extracted.
 *  - CSV: UTF-8 (with or without BOM), UTF-16 and Windows-1251; comma, semicolon, tab or pipe delimiters
 *    detected from the file; quoted fields with embedded delimiters, quotes and line breaks.
 * Row positions are kept, so row numbers match what the user sees in Excel.
 */
import { strFromU8, unzipSync } from "fflate"

import { LIMITS, type ImportFileErrorCode } from "./fields"

export class ImportFileError extends Error {
  constructor(
    public code: ImportFileErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ImportFileError"
  }
}

export type ParsedFile = { format: "CSV" | "XLSX"; encoding: string | null; delimiter: string | null; rows: string[][] }

const MAX_XML_BYTES = 60_000_000

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const cell = (v: string) => v.replace(CONTROL, "").trim().slice(0, LIMITS.maxCellChars)

export function readImportFile(fileName: string, bytes: Uint8Array, options: { delimiter?: string | null; encoding?: string | null } = {}): ParsedFile {
  if (bytes.length === 0) throw new ImportFileError("empty", "The file is empty.")
  if (bytes.length > LIMITS.maxBytes) throw new ImportFileError("too_large", `The file is larger than ${LIMITS.maxBytes / 1_000_000} MB.`)
  const name = fileName.toLowerCase()
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  let parsed: ParsedFile
  if (name.endsWith(".xls") || ole) throw new ImportFileError("legacy_xls", "Old Excel .xls files are not supported. Save the file as .xlsx or .csv.")
  if (name.endsWith(".xlsx")) {
    if (!zip) throw new ImportFileError("corrupt", "The file is not a valid .xlsx workbook.")
    parsed = { format: "XLSX", encoding: null, delimiter: null, rows: readXlsxRows(bytes) }
  } else if (name.endsWith(".csv") || name.endsWith(".txt")) {
    if (zip || ole || looksBinary(bytes)) throw new ImportFileError("corrupt", "The file does not look like CSV text.")
    const { text, encoding } = decodeText(bytes, options.encoding ?? null)
    const delimiter = options.delimiter && [",", ";", "\t", "|"].includes(options.delimiter) ? options.delimiter : detectDelimiter(text)
    parsed = { format: "CSV", encoding, delimiter, rows: parseCsv(text, delimiter) }
  } else {
    throw new ImportFileError("unsupported", "Only .xlsx and .csv files are supported.")
  }
  // Drop trailing empty rows; keep inner empty rows so row numbers stay true to the file.
  while (parsed.rows.length && parsed.rows[parsed.rows.length - 1].every((c) => !c)) parsed.rows.pop()
  if (!parsed.rows.length) throw new ImportFileError("no_rows", "The file has no rows.")
  if (parsed.rows.length > LIMITS.maxRows + 20) throw new ImportFileError("too_many_rows", `The file has more than ${LIMITS.maxRows} rows. Split it into smaller files.`)
  if (parsed.rows.some((r) => r.length > LIMITS.maxColumns)) throw new ImportFileError("too_many_columns", `The file has more than ${LIMITS.maxColumns} columns.`)
  return parsed
}

function looksBinary(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 4096)
  // UTF-16 text has many zero bytes; detect it before calling it binary.
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return false
  let zeros = 0
  for (const b of sample) if (b === 0) zeros++
  return zeros > 0
}

/** Decodes text: BOM first, then strict UTF-8, then Windows-1251 (common for Russian bank exports). */
export function decodeText(bytes: Uint8Array, forced: string | null): { text: string; encoding: string } {
  const decode = (enc: string, fatal = false) => new TextDecoder(enc, { fatal }).decode(bytes)
  if (forced && ["utf-8", "windows-1251", "utf-16le", "utf-16be"].includes(forced)) return { text: decode(forced).replace(/^﻿/, ""), encoding: forced }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: decode("utf-8").replace(/^﻿/, ""), encoding: "utf-8" }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decode("utf-16le").replace(/^﻿/, ""), encoding: "utf-16le" }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decode("utf-16be").replace(/^﻿/, ""), encoding: "utf-16be" }
  try {
    return { text: decode("utf-8", true), encoding: "utf-8" }
  } catch {
    return { text: decode("windows-1251"), encoding: "windows-1251" }
  }
}

/** The delimiter that splits the first lines into the most consistent number of columns. */
export function detectDelimiter(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15)
  let best = ","
  let bestScore = -1
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => parseCsv(l, d)[0]?.length ?? 1)
    if (!counts.length) continue
    const min = Math.min(...counts)
    if (min < 2) continue
    // Prefer delimiters that give the same column count on every line, then more columns.
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length
    const score = consistent * 100 + min
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field.trim() === "") {
      quoted = true
      field = ""
    } else if (ch === delimiter) {
      row.push(cell(field))
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell(field))
      rows.push(row.every((c) => !c) ? [] : row)
      row = []
      field = ""
      if (rows.length > LIMITS.maxRows + 50) break
    } else field += ch
  }
  if (field || row.length) {
    row.push(cell(field))
    rows.push(row)
  }
  return rows
}

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
const texts = (xml: string) => (xml.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>|<t\s*\/>/g) ?? []).map((t) => unesc(t.replace(/<[^>]+>/g, ""))).join("")

/** First worksheet of an XLSX workbook as text cells (stored values only). */
export function readXlsxRows(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>
  try {
    let total = 0
    files = unzipSync(bytes, {
      filter: (f) => {
        const wanted = f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name)
        if (!wanted) return false
        total += f.originalSize
        if (f.originalSize > MAX_XML_BYTES || total > MAX_XML_BYTES * 2) throw new ImportFileError("corrupt", "The workbook is too large to read safely.")
        return true
      },
    })
  } catch (e) {
    if (e instanceof ImportFileError) throw e
    throw new ImportFileError("corrupt", "The .xlsx file could not be opened.")
  }
  const text = (n: string) => (files[n] ? strFromU8(files[n]) : null)

  // First sheet in workbook order (not by file name).
  let sheetPath: string | null = null
  const workbook = text("xl/workbook.xml")
  const rels = text("xl/_rels/workbook.xml.rels")
  const firstSheet = workbook ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1] : undefined
  if (firstSheet && rels) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet}"[^>]*>`).exec(rels)?.[0]
    const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`
  }
  sheetPath ??= Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))[0] ?? null
  const sheet = sheetPath ? text(sheetPath) : null
  if (!sheet) throw new ImportFileError("corrupt", "The workbook has no worksheet.")

  const shared = (text("xl/sharedStrings.xml")?.match(/<si>[\s\S]*?<\/si>|<si\/>/g) ?? []).map(texts)
  const rows: string[][] = []
  for (const rowXml of sheet.match(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) ?? []) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowXml)?.[1] ?? rows.length + 1)
    if (rowNumber > LIMITS.maxRows + 50) throw new ImportFileError("too_many_rows", `The file has more than ${LIMITS.maxRows} rows. Split it into smaller files.`)
    const row: string[] = []
    for (const c of rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1]
      let index = row.length
      if (ref) {
        index = 0
        for (const ch of ref) index = index * 26 + (ch.charCodeAt(0) - 64)
        index -= 1
      }
      if (index >= LIMITS.maxColumns) throw new ImportFileError("too_many_columns", `The file has more than ${LIMITS.maxColumns} columns.`)
      const type = /\bt="(\w+)"/.exec(c)?.[1]
      // The stored value only: a formula (<f>) is ignored; its last calculated result is in <v>.
      const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1]
      let value = ""
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? ""
      else if (type === "inlineStr") value = texts(/<is>[\s\S]*?<\/is>/.exec(c)?.[0] ?? "")
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE"
      else if (type === "e") value = ""
      else if (v !== undefined) value = unesc(v)
      row[index] = cell(value)
    }
    while (rows.length < rowNumber - 1) rows.push([])
    rows.push(Array.from(row, (x) => x ?? ""))
  }
  return rows
}
