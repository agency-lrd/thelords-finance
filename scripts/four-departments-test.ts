/**
 * The four main departments of the financial sheet from November 2026 on a throwaway PGlite database
 * (never Supabase): exactly four tabs in order, legacy departments flagged (never guessed), explicit
 * dated reassignment, no new departments from employees or positions, October unchanged, rollover
 * working, no records lost. Synthetic data only. Usage: npm run test:four-departments
 */
import assert from "node:assert/strict"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54341)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const adminOps = await import("../src/lib/data/sheet-admin")
  const positions = await import("../src/lib/data/positions")
  const ledger = await import("../src/lib/data/project-ledger")
  const view = await import("../src/lib/department-view")
  const { Decimal } = await import("../src/lib/money")

  const oct = { year: 2026, month: 10 }
  const nov = { year: 2026, month: 11 }
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  const dept = (code: string) => prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code } })
  const influence = await dept("INFLULORDS")
  const bizdev = await dept("BIZDEV")
  const hr = await dept("HR")
  const ids: Record<string, string> = {}
  const rows = async (m: typeof nov) => (await sheet.getSheet(admin, m, prisma)).rows
  const positionId = async (name: string) => (await positions.listPositions(admin, prisma)).find((p) => p.name === name)!.id
  let octSnapshot = ""
  let departmentsBefore = 0

  try {
    await step("1-6. exactly four tabs in order: Influence, AI Production, Crypto Marketing, Traffic Affiliate", async () => {
      const list = await adminOps.listSheetDepartments(admin, nov, prisma)
      const tabs = view.mainDepartmentTabs(list)
      assert.deepEqual(tabs.map((x) => x.id), [influence.id, (await dept("AI-PRODUCTION")).id, (await dept("MARKETING")).id, (await dept("TRAFFICLORDS")).id])
      assert.ok(!tabs.some((t) => [bizdev.id, hr.id].includes(t.id)), "BizDev and HR are not tabs")
      departmentsBefore = await prisma.department.count({ where: { organizationId: org.id } })
    })

    await step("October (before the switch): legacy departments still accepted; approve", async () => {
      ids.Vlad = (await sheet.addSheetEmployee(admin, oct, { name: "Vlad BizDev", departmentId: bizdev.id, fix: "1500", currency: "USD", hireDate: d("2026-01-01"), positionId: await positionId("BizDev Manager") }, prisma)).id
      ids.Hanna = (await sheet.addSheetEmployee(admin, oct, { name: "Hanna HR", departmentId: hr.id, fix: "1200", currency: "USD", hireDate: d("2026-01-01"), positionId: await positionId("HR Manager") }, prisma)).id
      ids.Alex = (await sheet.addSheetEmployee(admin, oct, { name: "Alex Influence", departmentId: influence.id, fix: "1000", currency: "USD", hireDate: d("2026-01-01"), positionId: await positionId("Influencer Manager") }, prisma)).id
      await ledger.addLedgerEntry(admin, oct, "cost", { departmentId: hr.id, item: "HR tool", amount: new Decimal(90), currency: "USD", categoryId: null, projectId: null, clientId: null, clientName: null, teamId: null, date: null, notes: null, recurring: true }, prisma)
      for (const n of Object.keys(ids)) await sheet.setRowConfirmed(admin, oct, ids[n], true, prisma)
      await sheet.approveMonth(admin, oct, null, prisma)
      octSnapshot = JSON.stringify(await rows(oct))
    })

    await step("8. November: employees are added only to a main department; job titles never create departments", async () => {
      const sales = await positionId("Sales Manager")
      await assert.rejects(() => sheet.addSheetEmployee(admin, nov, { name: "Sales Person", departmentId: bizdev.id, fix: "900", currency: "USD", hireDate: null, positionId: sales }, prisma), /four main departments/)
      ids.Anna = (await sheet.addSheetEmployee(admin, nov, { name: "Anna SMM", departmentId: (await dept("AI-PRODUCTION")).id, fix: "1100", currency: "USD", hireDate: d("2026-11-03"), positionId: await positionId("SMM Manager") }, prisma)).id
      await positions.createPosition(admin, { name: "Course Launch Manager" }, prisma)
      assert.equal(await prisma.department.count({ where: { organizationId: org.id } }), departmentsBefore, "no department was created")
    })

    await step("12-13. rollover keeps legacy people where they were (flagged, never guessed); nothing lost", async () => {
      assert.deepEqual(await sheet.carryForwardEmployees(admin, nov, [{ employeeId: ids.Vlad }, { employeeId: ids.Hanna }, { employeeId: ids.Alex }], prisma), { added: 3, skipped: 0 })
      const list = await adminOps.listSheetDepartments(admin, nov, prisma)
      const main = new Set(view.mainDepartmentTabs(list).map((x) => x.id))
      const legacy = (await rows(nov)).filter((r) => !r.departmentId || !main.has(r.departmentId)).map((r) => r.name).sort()
      assert.deepEqual(legacy, ["Hanna HR", "Vlad BizDev"], "flagged for manual assignment")
      assert.equal(await prisma.employee.count({ where: { organizationId: org.id } }), 4)
      assert.equal(await prisma.projectCost.count({ where: { project: { organizationId: org.id } } }), 1, "the legacy cost is still there")
    })

    await step("explicit, dated reassignment from November; a legacy department cannot be chosen again", async () => {
      await assert.rejects(() => sheet.updateSheetCell(admin, nov, ids.Alex, "department", hr.id, prisma), /four main departments/)
      await sheet.updateSheetCell(admin, nov, ids.Vlad, "department", influence.id, prisma, bizdev.id)
      await sheet.updateSheetCell(admin, nov, ids.Hanna, "department", influence.id, prisma, hr.id)
      const v = (await rows(nov)).find((r) => r.employeeId === ids.Vlad)!
      assert.deepEqual([v.departmentId, v.positionName, v.fix], [influence.id, "BizDev Manager", "1500"], "position and FIX unchanged")
    })

    await step("7, 9-10. positions order inside Influence; totals; October unchanged", async () => {
      const inf = (await rows(nov)).filter((r) => r.departmentId === influence.id)
      assert.deepEqual(inf.map((r) => r.positionName), ["Influencer Manager", "BizDev Manager", "HR Manager"])
      assert.equal(inf.reduce((a, r) => a + Number(r.payable), 0), 1000 + 1500 + 1200)
      assert.equal(JSON.stringify(await rows(oct)), octSnapshot, "October keeps BizDev and HR")
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
