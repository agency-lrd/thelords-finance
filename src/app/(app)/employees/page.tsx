import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Employees" }

export default function EmployeesPage() {
  return <ModulePage href="/employees" />
}
