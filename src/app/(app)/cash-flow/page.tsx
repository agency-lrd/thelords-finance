import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Cash Flow" }

export default function CashFlowPage() {
  return <ModulePage href="/cash-flow" />
}
