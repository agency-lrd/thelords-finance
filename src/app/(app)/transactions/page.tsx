import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Transactions" }

export default function TransactionsPage() {
  return <ModulePage href="/transactions" />
}
