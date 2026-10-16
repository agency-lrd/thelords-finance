import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { ActionForm } from "@/components/shared/action-form"
import { Grid, SalaryFields } from "@/components/shared/fields"
import { PageHeader } from "@/components/shared/page-header"
import { PageSkeleton, Panel, Section } from "@/components/shared/page-skeleton"
import { StatusBadge } from "@/components/shared/status-badge"
import { Field, Input, Select } from "@/components/ui/form-controls"
import { NumTD, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table"
import { can, requirePageAccess } from "@/lib/auth/session"
import { getEmployee } from "@/lib/data/employees"
import { listDepartments } from "@/lib/data/settings"
import { formatMoney } from "@/lib/money"
import { isoDay, monthKey, monthLabel } from "@/lib/period"

import { addSalaryChangeAction, changeDepartmentAction, setEmployeeStatusAction } from "../actions"

export const metadata: Metadata = { title: "Employee" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function EmployeePage({ params }: PageProps<"/employees/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton title="Employee" />}>
      <EmployeeDetail params={params} />
    </Suspense>
  )
}

async function EmployeeDetail({ params }: { params: PageProps<"/employees/[id]">["params"] }) {
  const user = await requirePageAccess("employee:read")
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const employee = await getEmployee(user, id).catch(() => notFound())
  const departments = await listDepartments(user)
  const current = employee.assignments.find((a) => a.validTo === null)

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title={`${employee.firstName} ${employee.lastName}`}
        description={[employee.jobTitle, current?.department.name, `No. ${employee.employeeNumber}`].filter(Boolean).join(" · ")}
        actions={
          <div className="flex items-center gap-3">
            <StatusBadge status={employee.status} />
            <Link href="/employees" className="text-sm text-muted-foreground hover:text-foreground">
              ← All employees
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          ["Hire date", isoDay(employee.hireDate)],
          ["Termination", employee.terminationDate ? isoDay(employee.terminationDate) : "—"],
          ["Work email", employee.workEmail ?? "—"],
          ["Country", employee.country ?? "—"],
        ].map(([label, value]) => (
          <Panel key={label} className="p-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-sm">{value}</p>
          </Panel>
        ))}
      </div>

      {can(user, "payroll:read") && (
        <Section title="Monthly financial history" description="From the monthly financial sheets. Approved months are locked.">
          {employee.payrollItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No financial sheets include this employee yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Month</TH>
                  <TH>Department</TH>
                  <TH className="text-right">Gross</TH>
                  <TH className="text-right">Deductions</TH>
                  <TH className="text-right">Net</TH>
                  <TH className="text-right">Net ({user.baseCurrency})</TH>
                  <TH>Sheet</TH>
                </TR>
              </THead>
              <TBody>
                {employee.payrollItems.map((item) => {
                  const m = { year: item.payrollRun.period.year, month: item.payrollRun.period.month }
                  return (
                    <TR key={item.id}>
                      <TD>
                        <Link href={`/payroll?month=${monthKey(m)}`} className="hover:text-primary">
                          {monthLabel(m)}
                        </Link>
                      </TD>
                      <TD>{item.department?.name ?? "—"}</TD>
                      <NumTD>{formatMoney(item.grossAmount.toString(), item.currency)}</NumTD>
                      <NumTD>{formatMoney(item.deductionsAmount.toString(), item.currency)}</NumTD>
                      <NumTD>{formatMoney(item.netAmount.toString(), item.currency)}</NumTD>
                      <NumTD>{formatMoney(item.baseNetAmount.toString(), user.baseCurrency)}</NumTD>
                      <TD>
                        <StatusBadge status={item.payrollRun.status} />
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
          )}
        </Section>
      )}

      {can(user, "salary:read") && (
        <Section title="Salary history" description="Each change starts a new record; past months keep the salary that applied then.">
          <Table>
            <THead>
              <TR>
                <TH>From</TH>
                <TH>Until</TH>
                <TH>Basis</TH>
                <TH className="text-right">Amount</TH>
                <TH>Reason</TH>
                <TH>Approved by</TH>
              </TR>
            </THead>
            <TBody>
              {employee.salaryConditions.map((s) => (
                <TR key={s.id}>
                  <TD>{isoDay(s.validFrom)}</TD>
                  <TD className="text-muted-foreground">{s.validTo ? isoDay(s.validTo) : "current"}</TD>
                  <TD>{s.payBasis.replace("_", " ").toLowerCase()}</TD>
                  <NumTD>{formatMoney(s.baseAmount.toString(), s.currency)}</NumTD>
                  <TD className="text-muted-foreground">{s.changeReason ?? "—"}</TD>
                  <TD className="text-muted-foreground">{s.approvedBy?.email ?? <span className="text-amber-300">pending</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {can(user, "salary:manage") && (
            <Panel>
              <ActionForm action={addSalaryChangeAction.bind(null, employee.id)} submitLabel="Save salary change">
                <Grid>
                  <Field label="Effective from" htmlFor="validFrom">
                    <Input id="validFrom" name="validFrom" type="date" required />
                  </Field>
                  <SalaryFields prefix="s-" />
                  <Field label="Reason" htmlFor="reason" className="sm:col-span-2 lg:col-span-3">
                    <Input id="reason" name="reason" required maxLength={300} placeholder="e.g. Annual review" />
                  </Field>
                </Grid>
              </ActionForm>
            </Panel>
          )}
        </Section>
      )}

      <Section title="Department history">
        <Table>
          <THead>
            <TR>
              <TH>Department</TH>
              <TH>From</TH>
              <TH>Until</TH>
            </TR>
          </THead>
          <TBody>
            {employee.assignments.map((a) => (
              <TR key={a.id}>
                <TD>{a.department.name}</TD>
                <TD>{isoDay(a.validFrom)}</TD>
                <TD className="text-muted-foreground">{a.validTo ? isoDay(a.validTo) : "current"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {can(user, "employee:manage") && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <ActionForm action={changeDepartmentAction.bind(null, employee.id)} submitLabel="Move department">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="New department" htmlFor="move-departmentId">
                    <Select id="move-departmentId" name="departmentId" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="From" htmlFor="move-validFrom">
                    <Input id="move-validFrom" name="validFrom" type="date" required />
                  </Field>
                </div>
              </ActionForm>
            </Panel>
            <Panel>
              <ActionForm action={setEmployeeStatusAction.bind(null, employee.id)} submitLabel="Update status" resetOnSuccess={false}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Status" htmlFor="status">
                    <Select id="status" name="status" defaultValue={employee.status === "ONBOARDING" ? "ACTIVE" : employee.status}>
                      <option value="ACTIVE">Active</option>
                      <option value="ON_LEAVE">On leave</option>
                      <option value="TERMINATED">Terminated</option>
                    </Select>
                  </Field>
                  <Field label="Termination date" htmlFor="terminationDate" hint="Required when terminated.">
                    <Input id="terminationDate" name="terminationDate" type="date" defaultValue={isoDay(employee.terminationDate)} />
                  </Field>
                </div>
              </ActionForm>
            </Panel>
          </div>
        )}
      </Section>
    </div>
  )
}
