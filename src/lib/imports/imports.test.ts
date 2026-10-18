import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { strToU8, zipSync } from "fflate"

import { safeCell, writeXlsx } from "@/lib/xlsx"

import type { ImportSettings } from "./fields"
import { detectHeaderRow, suggestMapping } from "./mapping"
import { ImportFileError, readImportFile } from "./parse"
import { detectDateOrder, detectDecimal, parseImportAmount, parseImportDate, summarize, validateRows, type Lookups } from "./rows"

const utf8 = (s: string) => new TextEncoder().encode(s)
const fileError = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof ImportFileError && e.code === code)

describe("readImportFile", () => {
  it("reads CSV with comma, semicolon or tab, quotes, embedded delimiters and line breaks, and a BOM", () => {
    assert.deepEqual(readImportFile("a.csv", utf8('﻿date,description,amount\n2026-10-01,"Rent, office",100\n')).rows, [["date", "description", "amount"], ["2026-10-01", "Rent, office", "100"]])
    const semi = readImportFile("a.csv", utf8('Дата;Описание;Сумма\r\n01.10.2026;"Строка ""в кавычках""\nвторая";1 234,56\r\n'))
    assert.equal(semi.delimiter, ";")
    assert.deepEqual(semi.rows[1], ["01.10.2026", 'Строка "в кавычках"\nвторая', "1 234,56"])
    assert.equal(readImportFile("a.csv", utf8("a\tb\tc\n1\t2\t3")).delimiter, "\t")
  })

  it("detects UTF-16 and Windows-1251 encodings", () => {
    const text = "Дата;Сумма\n01.10.2026;100"
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...text].map((c) => c.charCodeAt(0))).buffer)])
    assert.equal(readImportFile("a.csv", utf16).rows[0][0], "Дата")
    // "Дата" in Windows-1251
    const cp1251 = new Uint8Array([0xc4, 0xe0, 0xf2, 0xe0, 0x3b, 0x31])
    const parsed = readImportFile("a.csv", cp1251)
    assert.equal(parsed.encoding, "windows-1251")
    assert.deepEqual(parsed.rows[0], ["Дата", "1"])
  })

  it("reads XLSX stored values only, in workbook sheet order, keeping row numbers", () => {
    assert.deepEqual(readImportFile("a.xlsx", writeXlsx([["date", "amount"], ["2026-10-01", 100]])).rows, [["date", "amount"], ["2026-10-01", "100"]])
    const files = {
      "xl/workbook.xml": strToU8('<workbook xmlns:r="r"><sheets><sheet name="Main" sheetId="1" r:id="rId7"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId7" Target="worksheets/sheet2.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8('<sst><si><t>Дата</t></si><si><r><t>Сум</t></r><r><t xml:space="preserve">ма</t></r></si><si><t>a &amp; b</t></si></sst>'),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>'),
      "xl/worksheets/sheet2.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3"><v>46296</v></c><c r="B3"><f>HYPERLINK("http://evil")+1</f><v>150.5</v></c><c r="C3" t="s"><v>2</v></c></row></sheetData></worksheet>',
      ),
    }
    const rows = readImportFile("bank.xlsx", zipSync(files)).rows
    assert.deepEqual(rows, [["Дата", "Сумма"], [], ["46296", "150.5", "a & b"]])
  })

  it("rejects empty, oversized, legacy, unsupported and disguised files", () => {
    fileError(() => readImportFile("a.csv", new Uint8Array()), "empty")
    fileError(() => readImportFile("a.csv", new Uint8Array(4_000_001).fill(65)), "too_large")
    fileError(() => readImportFile("a.xls", utf8("x")), "legacy_xls")
    fileError(() => readImportFile("a.pdf", utf8("%PDF")), "unsupported")
    fileError(() => readImportFile("a.xlsx", utf8("date,amount")), "corrupt")
    fileError(() => readImportFile("a.csv", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), "corrupt")
    fileError(() => readImportFile("a.csv", utf8("\n\n")), "no_rows")
    fileError(() => readImportFile("a.csv", utf8(Array.from({ length: 5100 }, (_, i) => `r${i}`).join("\n"))), "too_many_rows")
  })
})

describe("dates and amounts", () => {
  it("parses common date formats and Excel serial dates", () => {
    assert.equal(parseImportDate("2026-10-05", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("2026-10-05T12:00:00Z", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("05.10.2026", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("10/05/2026", "MDY"), "2026-10-05")
    assert.equal(parseImportDate("5/10/26", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("2026/10/05", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("5 окт 2026", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("5 Oct 2026", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("46300", "DMY"), "2026-10-05")
    assert.equal(parseImportDate("31.02.2026", "DMY"), null)
    assert.equal(parseImportDate("yesterday", "DMY"), null)
    assert.equal(detectDateOrder(["01/02/2026", "03/25/2026"]), "MDY")
    assert.equal(detectDateOrder(["25.03.2026", "01.02.2026"]), "DMY")
  })

  it("parses amounts with thousands, decimal commas, currency signs and negatives", () => {
    const p = (v: string, d: "." | "," = ".") => {
      const r = parseImportAmount(v, d)
      return r ? `${r.negative ? "-" : ""}${r.value.toString()}` : null
    }
    assert.equal(p("1,234.56"), "1234.56")
    assert.equal(p("1 234,56", ","), "1234.56")
    assert.equal(p("1.234,56", ","), "1234.56")
    assert.equal(p("1 234,5 ₽", ","), "1234.5")
    assert.equal(p("$1,000"), "1000")
    assert.equal(p("-250.00 USD"), "-250")
    assert.equal(p("(99.90)"), "-99.9")
    assert.equal(p("100-"), "-100")
    assert.equal(p("1'000.25"), "1000.25")
    assert.equal(p("abc"), null)
    assert.equal(p("1.2.3"), null)
    assert.equal(detectDecimal(["1 234,56", "10,5"]), ",")
    assert.equal(detectDecimal(["1,234.56", "10.5"]), ".")
  })
})

describe("mapping", () => {
  it("finds the header row under a bank preamble and suggests columns", () => {
    const rows = [["Выписка по счёту"], ["Период: октябрь"], ["Дата операции", "Назначение платежа", "Сумма", "Валюта", "Контрагент"], ["01.10.2026", "x", "1", "USD", "y"]]
    assert.equal(detectHeaderRow(rows), 2)
    assert.deepEqual(suggestMapping(rows[2]), { date: 0, description: 1, amount: 2, currency: 3, counterparty: 4 })
  })
})

const lookups = (extra: Partial<Lookups> = {}): Lookups => ({
  baseCurrency: "USD",
  currencies: ["USD", "EUR", "GBP", "USDT"],
  accounts: [{ id: "acc-1", name: "Bank USD", currency: "USD" }, { id: "acc-2", name: "Wallet", currency: "USDT" }],
  categories: [
    { id: "cat-r", name: "Influencer revenue", kind: "REVENUE", code: "INFLUENCER-REVENUE" },
    { id: "cat-e", name: "Software", kind: "OPERATING_EXPENSE", code: "SOFTWARE" },
  ],
  departments: [{ id: "dep-1", name: "Clipping" }],
  clients: [{ id: "cli-1", name: "Big Client" }],
  projects: [],
  owners: [{ id: "own-1", name: "Owner Test" }],
  closedMonths: new Set(["2026-01"]),
  fxMonths: new Set(["EUR|2026-10"]),
  existingKeys: new Set(),
  existingFingerprints: new Set(),
  ...extra,
})

const settings = (mapping: ImportSettings["mapping"], defaults: Partial<ImportSettings["defaults"]> = {}): ImportSettings => ({ headerRow: 0, mapping, dateFormat: "auto", decimal: "auto", defaults: { type: null, currency: null, account: null, category: null, ...defaults } })
const M = { date: 0, description: 1, amount: 2, currency: 3, type: 4, account: 5, category: 6, department: 7, counterparty: 8 }
const head = ["date", "description", "amount", "currency", "type", "account", "category", "department", "counterparty"]

describe("validateRows", () => {
  it("validates each row with file row numbers and the transaction rules", () => {
    const rows = [
      head,
      ["05.10.2026", "Contract", "1 500,00", "USD", "Выручка", "Bank USD", "Influencer revenue", "Clipping", ""],
      ["06.10.2026", "Subscription", "-120,00", "USD", "Операционный расход", "Bank USD", "Software", "", ""],
      ["", "No date", "10", "USD", "expense", "Bank USD", "Software", "", ""],
      ["07.10.2026", "Bad type", "10", "USD", "magic", "Bank USD", "", "", ""],
      ["08.10.2026", "Wrong category", "10", "USD", "Выручка", "Bank USD", "Software", "", ""],
      ["09.01.2026", "Closed month", "10", "USD", "expense", "Bank USD", "Software", "", ""],
      ["09.10.2026", "Unknown account", "10", "USD", "expense", "Nope", "Software", "Sales", ""],
      ["10.10.2026", "Euro", "10", "EUR", "expense", "Bank USD", "Software", "", ""],
      ["10.11.2026", "Euro without rate", "10", "EUR", "expense", "Bank USD", "Software", "", ""],
      ["11.10.2026", "Owner money", "5000", "USD", "Взнос собственника", "Bank USD", "", "", "Owner Test"],
      ["12.10.2026", "=HYPERLINK(1)", "5", "USD", "expense", "Bank USD", "Software", "", ""],
      ["13.10.2026", "Refund", "5", "USD", "Возврат", "Bank USD", "Software", "", ""],
    ]
    const out = validateRows(rows, settings(M), lookups())
    const by = (n: number) => out.find((r) => r.row === n)!
    const codes = (n: number) => by(n).issues.map((i) => i.code)
    assert.equal(by(2).status, "ok")
    assert.deepEqual(by(2).input && { type: by(2).input!.type, amount: by(2).input!.amount, categoryId: by(2).input!.categoryId, departmentId: by(2).input!.departmentId }, { type: "REVENUE", amount: "1500", categoryId: "cat-r", departmentId: "dep-1" })
    assert.equal(by(3).status, "warning")
    assert.deepEqual(codes(3), ["negative_amount"])
    assert.equal(by(3).input!.amount, "120")
    assert.deepEqual(codes(4), ["date_required"])
    assert.deepEqual(codes(5), ["type_unknown"])
    assert.deepEqual(codes(6), ["category_kind"])
    assert.deepEqual(codes(7), ["period_closed"])
    assert.deepEqual(codes(8), ["account_not_found", "department_not_found"])
    assert.equal(by(9).status, "ok")
    assert.deepEqual(codes(10), ["fx_missing"])
    assert.equal(by(11).input!.shareholderId, "own-1")
    assert.deepEqual(codes(12), ["formula_text"])
    assert.deepEqual(codes(13), ["type_manual_only"])
    assert.ok(out.filter((r) => r.status === "error").every((r) => !r.include && !r.input))
  })

  it("never infers the type from the sign; a default type must be chosen explicitly", () => {
    const rows = [["date", "description", "amount"], ["05.10.2026", "Incoming", "1000"]]
    const noType = validateRows(rows, settings({ date: 0, description: 1, amount: 2 }, { account: "acc-1" }), lookups())
    assert.deepEqual(noType[0].issues.map((i) => i.code), ["type_required"])
    const withDefault = validateRows(rows, settings({ date: 0, description: 1, amount: 2 }, { account: "acc-1", type: "OWNER_CONTRIBUTION" }), lookups())
    assert.deepEqual(withDefault[0].issues.map((i) => i.code), ["owner_not_found"])
  })

  it("flags duplicates in the file, already imported rows and possible duplicates", () => {
    const row = ["05.10.2026", "Same", "10", "USD", "expense", "Bank USD", "Software", "", ""]
    const first = validateRows([head, row, row], settings(M), lookups())
    assert.deepEqual(first.map((r) => [r.row, r.status, r.include]), [[2, "ok", true], [3, "duplicate", false]])
    assert.notEqual(first[0].key, first[1].key, "a repeated row gets its own key")
    const again = validateRows([head, row, row], settings(M), lookups({ existingKeys: new Set([first[0].key!]) }))
    assert.deepEqual(again.map((r) => r.issues.map((i) => i.code)), [["already_imported"], ["duplicate_in_file"]])
    const similar = validateRows([head, row], settings(M), lookups({ existingFingerprints: new Set(["2026-10-05|OPERATING_EXPENSE|10|USD"]) }))
    assert.deepEqual(similar[0].issues.map((i) => i.code), ["possible_duplicate"])
    assert.equal(similar[0].include, true)
  })

  it("totals never count transfers, owner money or loans as income", () => {
    const rows = [
      head,
      ["05.10.2026", "Sale", "100", "USD", "Выручка", "Bank USD", "Influencer revenue", "", ""],
      ["05.10.2026", "Owner money", "500", "USD", "Взнос собственника", "Bank USD", "", "", "Owner Test"],
      ["05.10.2026", "Loan", "300", "USD", "Получение займа", "Bank USD", "", "", ""],
      ["05.10.2026", "Tool", "40", "USD", "expense", "Bank USD", "Software", "", ""],
    ]
    const out = validateRows(rows, settings(M), lookups())
    assert.deepEqual(summarize(out, (r) => r.include).totals, [{ currency: "USD", income: "100", expense: "40", other: "800", count: 4 }])
  })
})

describe("CSV export safety", () => {
  it("neutralizes text that a spreadsheet would run as a formula, but not numbers", () => {
    assert.equal(safeCell("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")")
    assert.equal(safeCell("+cmd"), "'+cmd")
    assert.equal(safeCell("@SUM(A1)"), "'@SUM(A1)")
    assert.equal(safeCell("-100.50"), "-100.50")
    assert.equal(safeCell("Rent"), "Rent")
  })
})
