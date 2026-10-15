import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Departments" }

export default function DepartmentsPage() {
  return <ModulePage href="/departments" />
}
