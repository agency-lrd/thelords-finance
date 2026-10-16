import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { readCsv, readXlsx, toCsv, writeXlsx } from "./xlsx"

describe("xlsx", () => {
  it("round-trips text, numbers and special characters", () => {
    const rows = [["Дата", "Описание", "Сумма"], ["2026-10-01", 'Почты "INFL" & <co>', "1200.5"], ["2026-10-02", "", "-3"]]
    assert.deepEqual(readXlsx(writeXlsx(rows)), rows)
  })
})

describe("csv", () => {
  it("reads quoted, comma and semicolon files", () => {
    assert.deepEqual(readCsv('a,b\n"1,5","x ""y"""\n'), [["a", "b"], ["1,5", 'x "y"']])
    assert.deepEqual(readCsv("a;b\r\n1;2"), [["a", "b"], ["1", "2"]])
    assert.deepEqual(readCsv(toCsv([["a", "b"], ["1", 'q"']])), [["a", "b"], ["1", 'q"']])
  })
})
