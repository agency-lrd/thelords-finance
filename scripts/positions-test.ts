/**
 * Employee positions end to end on a throwaway PGlite database (never Supabase): default directory,
 * position-based sorting inside departments, rename/reorder/archive, dated position changes, October ->
 * November rollover with a new position, unchanged approved history. Synthetic data only.
 * Usage: npm run test:positions
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54340)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const positions = await import("../src/lib/data/positions")
  const view = await import("../src/lib/department-view")

  const oct = { year: 2026, month: 10 }
  const nov = { year: 2026, month: 11 }
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  const influence = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  const pos = async () => positions.listPositions(admin, prisma)
  const id = async (name: string) => (await pos()).find((p) => p.name === name)!.id
  const ids: Record<string, string> = {}
  const add = async (name: string, position: string | null, m = oct) =>
    (ids[name] = (await sheet.addSheetEmployee(admin, m, { name, departmentId: influence.id, fix: "1000", currency: "USD", hireDate: d("2026-01-01"), positionId: position ? await id(position) : null }, prisma)).id)
  const order = async (m = oct) => (await sheet.getSheet(admin, m, prisma)).rows.filter((r) => r.departmentId === influence.id).map((r) => `${r.positionName ?? "—"}: ${r.name}`)
  let octBefore = ""

  try {
    await step("the default directory: 30 positions in the given order, seeded once (idempotent)", async () => {
      const list = await pos()
      assert.equal(list.length, 30)
      assert.deepEqual(list.slice(0, 4).map((p) => p.name), ["Influencer Manager", "Searcher", "Team Lead", "Head of Influencer Marketing"])
      assert.equal(list[29].name, "Head of Marketing")
      await pos()
      assert.equal(await prisma.position.count({ where: { organizationId: org.id } }), 30, "listing again never duplicates")
    })

    await step("1-3. employees with positions are inserted into their position group, same positions by name", async () => {
      await add("Vlad", "Team Lead")
      await add("Dmitry", "Head of Influencer Marketing")
      await add("Maks", "Searcher")
      await add("Andrey", "Influencer Manager")
      await add("Alexander", "Influencer Manager")
      await add("Nobody", null)
      assert.deepEqual(await order(), ["Influencer Manager: Alexander", "Influencer Manager: Andrey", "Searcher: Maks", "Team Lead: Vlad", "Head of Influencer Marketing: Dmitry", "—: Nobody"])
    })

    await step("4-5. reorder and rename positions: the sheet follows at once, totals unchanged", async () => {
      const total = async () => (await sheet.getSheet(admin, oct, prisma)).rows.reduce((a, r) => a + Number(r.payable), 0)
      const before = await total()
      await positions.updatePosition(admin, await id("Searcher"), { move: "up" }, prisma)
      assert.deepEqual((await order()).slice(0, 3), ["Searcher: Maks", "Influencer Manager: Alexander", "Influencer Manager: Andrey"])
      await positions.updatePosition(admin, await id("Searcher"), { name: "Talent Searcher", nameRu: "Сёрчер" }, prisma)
      assert.equal((await order())[0], "Talent Searcher: Maks")
      assert.equal(await total(), before)
      await assert.rejects(() => positions.createPosition(admin, { name: "team lead" }, prisma), /already exists/)
      await positions.createPosition(admin, { name: "Stream Producer", nameRu: "Продюсер стримов" }, prisma)
      assert.equal((await pos()).filter((p) => !p.archived).at(-1)!.name, "Stream Producer", "new positions go to the end")
    })

    await step("8-9 (prep). approve October with its positions", async () => {
      for (const n of Object.keys(ids)) await sheet.setRowConfirmed(admin, oct, ids[n], true, prisma)
      await sheet.approveMonth(admin, oct, null, prisma)
      octBefore = JSON.stringify(await order())
    })

    await step("10-13. rollover October -> November: positions carry, one changes in the modal; FIX/KPI unchanged; no duplicates", async () => {
      const preview = await sheet.carryForwardPreview(admin, nov, prisma)
      assert.equal(preview.employees.find((e) => e.employeeId === ids.Vlad)!.positionName, "Team Lead")
      const items = Object.values(ids).map((employeeId) => ({ employeeId, ...(employeeId === ids.Alexander ? { positionId: null as string | null } : {}) }))
      items.find((i) => i.employeeId === ids.Alexander)!.positionId = await id("Team Lead")
      assert.deepEqual(await sheet.carryForwardEmployees(admin, nov, items, prisma), { added: 6, skipped: 0 })
      const a = (await sheet.getSheet(admin, nov, prisma)).rows.find((r) => r.employeeId === ids.Alexander)!
      assert.deepEqual([a.positionName, a.fix, a.commissionPct, a.hireDate], ["Team Lead", "1000", "10", "2026-01-01"])
      assert.deepEqual(await sheet.carryForwardEmployees(admin, nov, items, prisma), { added: 0, skipped: 6 })
      assert.equal(await prisma.payrollMonthEmployee.count({ where: { period: { year: 2026, month: 11 } } }), 6)
    })

    await step("8-9. changing a position in November never changes approved October", async () => {
      await sheet.updateSheetCell(admin, nov, ids.Vlad, "positionId", await id("Head of Influencer Marketing"), prisma)
      const v = (await sheet.getSheet(admin, nov, prisma)).rows.find((r) => r.employeeId === ids.Vlad)!
      assert.deepEqual([v.positionName, v.fix], ["Head of Influencer Marketing", "1000"], "FIX unchanged by a position change")
      assert.equal(JSON.stringify(await order()), octBefore, "October keeps its positions")
      const o = (await sheet.getSheet(admin, oct, prisma)).rows.find((r) => r.employeeId === ids.Vlad)!
      assert.equal(o.positionName, "Team Lead")
    })

    await step("6-7. archiving a position keeps every linked record; archived positions cannot be newly assigned", async () => {
      const searcher = await id("Talent Searcher")
      await positions.updatePosition(admin, searcher, { archived: true }, prisma)
      assert.equal((await order(oct))[0], "Talent Searcher: Maks", "history still shows it")
      assert.equal((await sheet.getSheet(admin, nov, prisma)).rows.find((r) => r.employeeId === ids.Maks)!.positionName, "Talent Searcher")
      await assert.rejects(() => sheet.updateSheetCell(admin, nov, ids.Nobody, "positionId", searcher, prisma), /Position not found/)
      await positions.updatePosition(admin, searcher, { archived: false }, prisma)
      await sheet.updateSheetCell(admin, nov, ids.Nobody, "positionId", searcher, prisma)
    })

    await step("14, 22. department view from November 2026; October totals and payslips unchanged", async () => {
      assert.equal(view.departmentViewActive("2026-10"), false)
      assert.equal(view.departmentViewActive("2026-11"), true)
      const octRows = (await sheet.getSheet(admin, oct, prisma)).rows
      assert.equal(octRows.reduce((a, r) => a + Number(r.approved), 0), 6000)
      assert.equal(await prisma.payrollItem.count({ where: { payrollRun: { period: { year: 2026, month: 10 } } } }), 6)
    })
  } finally {
    summary()
    await stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
