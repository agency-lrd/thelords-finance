import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "P&L" }

export default function PnlPage() {
  return <ModulePage href="/pnl" />
}
