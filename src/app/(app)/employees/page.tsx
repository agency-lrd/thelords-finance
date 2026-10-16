import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import { ActionForm } from "@/components/shared/action-form"
import { EmptyState } from "@/components/shared/empty-state"
import { Grid, SalaryFields } from "@/components/shared/fields"
import { PageHeader } from "@/components/shared/page-header"
import { PageSkeleton, Panel, Section } from "@/components/shared/page-skeleton"
import { StatusBadge } from "@/components/shared/status-badge"
import { Field, Input, Select } from "@/components/ui/form-controls"
import { NumTD, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table"
import { can, requirePageAccess } from "@/lib/auth/session"
import { listEmployees } from "@/lib/data/employees"
import { listDepartments } from "@/lib/data/settings"
import { formatMoney } from "@/lib/money"
import { Users } from "lucide-react"

import { createEmployeeAction } from "./actions"

export const metadata: Metadata = { title: "Employees" }

const TITLE = "Employees"
const DESCRIPTION = "Team members, their current department and salary. Open an employee for full history."

export default function EmployeesPage() {
  return (
    <Suspense fallback={<PageSkeleton title={TITLE} description={DESCRIPTION} />}>
      <Employees />
    </Suspense>
  )
}

async function Employees() {
  const user = await requirePageAccess("employee:read")
  const [employees, departments] = await Promise.all([listEmployees(user), listDepartments(user)])
  const showSalary = can(user, "salary:read")
  const canAdd = can(user, "employee:manage") && can(user, "salary:manage")

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title={TITLE} description={DESCRIPTION} />

      {employees.length === 0 ? (
        <EmptyState icon={Users} title="No employees yet" description="Add the first team member below. Departments are managed in Settings." />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Employee</TH>
              <TH>No.</TH>
              <TH>Department</TH>
              <TH>Title</TH>
              {showSalary && <TH className="text-right">Current pay</TH>}
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {employees.map((e) => {
              const salary = e.salaryConditions[0]
              return (
                <TR key={e.id}>
                  <TD>
                    <Link href={`/employees/${e.id}`} className="font-medium hover:text-primary">
                      {e.firstName} {e.lastName}
                    </Link>
                  </TD>
                  <TD className="text-muted-foreground">{e.employeeNumber}</TD>
                  <TD>{e.assignments[0]?.department.name ?? <span className="text-muted-foreground">—</span>}</TD>
                  <TD className="text-muted-foreground">{e.jobTitle ?? "—"}</TD>
                  {showSalary && (
                    <NumTD>
                      {salary ? (
                        <>
                          {formatMoney(salary.baseAmount.toString(), salary.currency)}
                          <span className="ml-1 text-[11px] text-muted-foreground">/{salary.payBasis === "HOURLY" ? "h" : salary.payBasis === "DAILY" ? "day" : "mo"}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </NumTD>
                  )}
                  <TD>
                    <StatusBadge status={e.status} />
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>
      )}

      {canAdd && (
        <Section title="Add employee" description="Creates the employee with their department and starting salary from the hire date.">
          <Panel>
            {departments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Create a department first in <Link href="/settings" className="text-primary hover:underline">Settings</Link>.
              </p>
            ) : (
              <ActionForm action={createEmployeeAction} submitLabel="Add employee">
                <Grid>
                  <Field label="First name" htmlFor="firstName">
                    <Input id="firstName" name="firstName" required maxLength={80} />
                  </Field>
                  <Field label="Last name" htmlFor="lastName">
                    <Input id="lastName" name="lastName" required maxLength={80} />
                  </Field>
                  <Field label="Employee number" htmlFor="employeeNumber">
                    <Input id="employeeNumber" name="employeeNumber" required maxLength={40} />
                  </Field>
                  <Field label="Hire date" htmlFor="hireDate">
                    <Input id="hireDate" name="hireDate" type="date" required />
                  </Field>
                  <Field label="Department" htmlFor="departmentId">
                    <Select id="departmentId" name="departmentId" required defaultValue="">
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
                  <Field label="Job title" htmlFor="jobTitle">
                    <Input id="jobTitle" name="jobTitle" maxLength={120} />
                  </Field>
                  <Field label="Work email" htmlFor="workEmail">
                    <Input id="workEmail" name="workEmail" type="email" maxLength={200} />
                  </Field>
                  <Field label="Country" htmlFor="country" hint="2-letter code">
                    <Input id="country" name="country" maxLength={2} placeholder="GB" />
                  </Field>
                  <SalaryFields />
                </Grid>
              </ActionForm>
            )}
          </Panel>
        </Section>
      )}
    </div>
  )
}
