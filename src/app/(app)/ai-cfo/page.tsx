import type { Metadata } from "next"

import { ModulePage } from "@/components/shared/module-page"

export const metadata: Metadata = { title: "AI CFO" }

export default function AiCfoPage() {
  return <ModulePage href="/ai-cfo" />
}
