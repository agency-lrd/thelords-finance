import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Balance Sheet" }

export default function BalanceSheetPage() {
  return <ModulePage href="/balance-sheet" />
}
