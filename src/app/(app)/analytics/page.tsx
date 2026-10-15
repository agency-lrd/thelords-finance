import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "Analytics" }

export default function AnalyticsPage() {
  return <ModulePage href="/analytics" />
}
