import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Payroll" }

export default function PayrollPage() {
  return <ModulePage href="/payroll" />
}
