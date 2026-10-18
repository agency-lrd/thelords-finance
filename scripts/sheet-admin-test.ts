/**
 * Financial sheet administration end to end on a throwaway PGlite database (never Supabase): the
 * fourteen everyday workflows (employees, departments, salary, KPI, archive, deletion rules, history
 * and report stability, concurrent edits). All data is fictional.
 * Usage: npm run test:sheet-admin
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

import { startTestDb, stepRunner } from "./lib/test-db"

async function main() {
  const { prisma, admin, org, stop } = await startTestDb(54334)
  const { step, summary } = stepRunner()
  const sheet = await import("../src/lib/data/sheet")
  const adminOps = await import("../src/lib/data/sheet-admin")
  const reports = await import("../src/lib/reports/ledger")
  const { range } = await import("../src/lib/reports/periods")

  const sep = { year: 2026, month: 9 }
  const oct = { year: 2026, month: 10 }
  const infl = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "INFLULORDS" } })
  const bizdev = await prisma.department.findFirstOrThrow({ where: { organizationId: org.id, code: "BIZDEV" } })
  let employeeId = ""
  let deptId = ""
  const row = async (m = sep, id = employeeId) => (await sheet.getSheet(admin, m, prisma)).rows.find((r) => r.employeeId === id)
  const edit = (field: Parameters<typeof sheet.updateSheetCell>[3], value: string, expected?: string, m = sep, user = admin) => sheet.updateSheetCell(user, m, employeeId, field, value, prisma, expected)

  try {
    await step("1. create an employee from the sheet", async () => {
      const e = await sheet.addSheetEmployee(admin, sep, { name: "Anna Test", departmentId: infl.id, fix: "1200", currency: "USD", hireDate: null }, prisma)
      employeeId = e.id
      const r = (await row())!
      assert.deepEqual([r.name, r.departmentName, r.fix, r.calculated], ["Anna Test", infl.name, "1200", "1200"])
    })

    await step("2. rename the employee (with the value the user saw)", async () => {
      await edit("name", "Anna Renamed", "Anna Test")
      assert.equal((await row())!.name, "Anna Renamed")
      assert.equal(await prisma.employee.count({ where: { organizationId: org.id, firstName: "Anna" } }), 1, "no duplicate employee")
    })

    await step("3. create a department with a color", async () => {
      const d = await adminOps.createSheetDepartment(admin, { name: "Creative Lab", color: "teal", costClassification: "COST_OF_SALES" }, prisma)
      deptId = d.id
      await assert.rejects(() => adminOps.createSheetDepartment(admin, { name: "creative lab", color: null, costClassification: "OPERATING_EXPENSE" }, prisma), /already exists/)
      const list = await adminOps.listSheetDepartments(admin, sep, prisma)
      assert.deepEqual(list.find((x) => x.id === deptId), { id: deptId, name: "Creative Lab", color: "teal", archived: false, employees: 0, hasHistory: false })
    })

    await step("4. rename the department: the new name shows everywhere, the id stays", async () => {
      await adminOps.renameDepartment(admin, deptId, "Creative Studio", prisma)
      assert.equal((await prisma.department.findUniqueOrThrow({ where: { id: deptId } })).name, "Creative Studio")
      await adminOps.setDepartmentColor(admin, deptId, "violet", prisma)
      await assert.rejects(() => adminOps.setDepartmentColor(admin, deptId, "#ff0000", prisma), /palette/)
    })

    await step("5. assign the employee to another department", async () => {
      await edit("department", deptId, infl.id)
      const r = (await row())!
      assert.deepEqual([r.departmentId, r.departmentName], [deptId, "Creative Studio"])
    })

    await step("6. edit the salary: payroll recalculates, a confirmed row is un-confirmed, nothing is approved", async () => {
      await sheet.setRowConfirmed(admin, sep, employeeId, true, prisma)
      assert.equal((await row())!.confirmed, true)
      const result = await edit("fix", "1500", "1200")
      assert.equal(result.unconfirmed, true)
      const r = (await row())!
      assert.deepEqual([r.fix, r.calculated, r.confirmed], ["1500", "1500", false])
      const run = await prisma.payrollRun.findFirst({ where: { organizationId: org.id } })
      assert.ok(!run || run.status === "DRAFT" || run.status === "CALCULATED", "never approved by an edit")
    })

    await step("7. edit KPI profit and fact: the commission recalculates", async () => {
      await sheet.setCompensationRule(admin, sep, employeeId, { model: "PCT_ABOVE_KPI", ratePct: "10" }, prisma)
      await edit("kpiTarget", "10000", "")
      await edit("kpiActual", "15000", "")
      const r = (await row())!
      assert.equal(r.variable, "500") // 10% of the 5,000 above the KPI
      assert.equal(r.calculated, "2000")
    })

    await step("8. archive the employee", async () => {
      const other = await sheet.addSheetEmployee(admin, sep, { name: "Boris Temp", departmentId: bizdev.id, fix: "800", currency: "USD", hireDate: null }, prisma)
      await sheet.setEmployeeArchived(admin, other.id, true, prisma)
      const archived = await adminOps.listArchivedEmployees(admin, prisma)
      assert.deepEqual(archived.map((e) => [e.name, e.hasHistory]), [["Boris Temp", false]])
      assert.equal(await row(sep, other.id), undefined, "archived employees leave the sheet")
    })

    await step("9. restore the employee", async () => {
      const boris = await prisma.employee.findFirstOrThrow({ where: { firstName: "Boris" } })
      await sheet.setEmployeeArchived(admin, boris.id, false, prisma)
      assert.ok(await row(sep, boris.id))
      assert.deepEqual(await adminOps.listArchivedEmployees(admin, prisma), [])
    })

    let pnlBefore = ""
    await step("10. deletion: refused with payroll history, allowed (with typed name and permission) without", async () => {
      // Pay history for Anna: confirm both rows and approve September (posts the payroll accrual).
      const boris = await prisma.employee.findFirstOrThrow({ where: { firstName: "Boris" } })
      await sheet.setRowConfirmed(admin, sep, employeeId, true, prisma)
      await sheet.setRowConfirmed(admin, sep, boris.id, true, prisma)
      await sheet.approveMonth(admin, sep, null, prisma)
      pnlBefore = JSON.stringify((await reports.pnlReport(admin, range("month", 2026, 9), {}, prisma)).current)
      await assert.rejects(() => adminOps.deleteEmployee(admin, employeeId, "Anna Renamed", prisma), /financial history/)
      const fresh = await sheet.addSheetEmployee(admin, oct, { name: "Mistake Person", departmentId: bizdev.id, fix: "100", currency: "USD", hireDate: null }, prisma)
      await assert.rejects(() => adminOps.deleteEmployee(admin, fresh.id, "Wrong Name", prisma), /Type the employee's name/)
      const noSalary = { ...admin, permissions: new Set([...admin.permissions].filter((p) => p !== "salary:manage")) as typeof admin.permissions }
      await assert.rejects(() => adminOps.deleteEmployee(noSalary, fresh.id, "Mistake Person", prisma), /permission/)
      await adminOps.deleteEmployee(admin, fresh.id, "Mistake Person", prisma)
      assert.equal(await prisma.employee.count({ where: { id: fresh.id } }), 0)
      assert.equal(await prisma.auditLog.count({ where: { action: "employee.delete", entityId: fresh.id } }), 1)
    })

    await step("11. a department with financial records: rename ok, delete refused, archive needs it emptied, merge keeps history", async () => {
      // October starts from the approved September.
      const boris = await prisma.employee.findFirstOrThrow({ where: { firstName: "Boris" } })
      assert.deepEqual(await sheet.carryForwardEmployees(admin, oct, [{ employeeId }, { employeeId: boris.id }], prisma), { added: 2, skipped: 0 })
      await adminOps.renameDepartment(admin, deptId, "Creative Hub", prisma)
      await assert.rejects(() => adminOps.deleteDepartment(admin, deptId, prisma), /Archive it or merge/)
      await assert.rejects(() => adminOps.setSheetDepartmentArchived(admin, deptId, true, oct, prisma), /still has 1 employee/)
      await adminOps.mergeDepartments(admin, deptId, bizdev.id, oct, prisma)
      const octRow = (await row(oct))!
      assert.equal(octRow.departmentId, bizdev.id, "from October the employee is in the target")
      const sepRow = (await row(sep))!
      assert.equal(sepRow.departmentId, deptId, "September keeps the merged department")
      assert.equal(sepRow.departmentName, "Creative Hub")
      assert.equal((await prisma.department.findUniqueOrThrow({ where: { id: deptId } })).archivedAt !== null, true)
      const payslip = await prisma.payrollItem.findFirstOrThrow({ where: { employeeId } })
      assert.equal(payslip.departmentId, deptId, "the approved payslip keeps its department")
      // An unused department can be deleted.
      const empty = await adminOps.createSheetDepartment(admin, { name: "Never Used", color: null, costClassification: "OPERATING_EXPENSE" }, prisma)
      await adminOps.deleteDepartment(admin, empty.id, prisma)
      await assert.rejects(() => adminOps.renameDepartment({ ...admin, permissions: new Set(["payroll:read"]) as typeof admin.permissions }, bizdev.id, "X", prisma), /permission/)
    })

    await step("12. historical reports are unchanged by renames and merges", async () => {
      const after = JSON.stringify((await reports.pnlReport(admin, range("month", 2026, 9), {}, prisma)).current)
      assert.equal(after, pnlBefore)
      const byDept = await reports.departmentPnl(admin, range("month", 2026, 9), prisma)
      const merged = byDept.find((d) => d.id === deptId)!
      assert.equal(merged.name, "Creative Hub")
      assert.equal(merged.pnl.costOfServices, "2000", "Anna's approved September pay stays with her September department")
    })

    await step("13. P&L payroll equals the approved payroll total", async () => {
      const rows = (await sheet.getSheet(admin, sep, prisma)).rows
      const approved = rows.reduce((a, r) => a + Number(r.approved ?? 0), 0)
      assert.equal(approved, 2800) // Anna 2,000 + Boris 800
      const pnl = (await reports.pnlReport(admin, range("month", 2026, 9), {}, prisma)).current
      assert.equal(Number(pnl.costOfServices) + Number(pnl.operatingExpenses), 2800)
      await assert.rejects(() => edit("fix", "9999", "1500"), /approved/)
    })

    await step("14. two users editing the same cell: the second is refused instead of overwriting", async () => {
      const bob = { ...admin, id: randomUUID() }
      await prisma.appUser.create({ data: { id: bob.id, email: "bob@example.test", status: "ACTIVE", isSuperAdmin: true } })
      // Both opened October with FIX 1,500 on screen.
      await edit("fix", "1700", "1500", oct, admin)
      await assert.rejects(() => edit("fix", "1600", "1500", oct, bob), (e) => e instanceof sheet.SheetConflictError && e.current === "1700")
      assert.equal((await row(oct))!.fix, "1700")
      // Simultaneous saves from the same starting value: exactly one wins.
      const results = await Promise.allSettled([edit("notes", "from Anna's manager", "", oct, admin), edit("notes", "from Bob", "", oct, bob)])
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"])
      // Without an expected value (old clients), saves still work as before.
      await edit("notes", "plain save", undefined, oct, bob)
      assert.equal((await row(oct))!.notes, "plain save")
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
