import { ArrowLeftRight, Banknote, LayoutDashboard, Users } from "lucide-react"
import Link from "next/link"

import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const metrics = ["Revenue", "Expenses", "Net Profit", "Cash Balance"] as const

const setupSteps = [
  { title: "Add employees", href: "/employees", icon: Users },
  { title: "Configure payroll", href: "/payroll", icon: Banknote },
  { title: "Record transactions", href: "/transactions", icon: ArrowLeftRight },
] as const

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Dashboard"
        description="A consolidated view of company finances. Metrics appear here once real data is recorded."
      />

      <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((label) => (
          <Card key={label} className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              <span className="text-2xl font-semibold text-muted-foreground/50" aria-label="No data">
                —
              </span>
              <span className="text-xs text-muted-foreground">No data yet</span>
            </CardContent>
          </Card>
        ))}
      </section>

      <EmptyState
        icon={LayoutDashboard}
        title="Your financial dashboard is empty"
        description="No financial data has been connected or recorded yet. Start by setting up your team and recording transactions — reports and analytics will build from there."
      >
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {setupSteps.map(({ title, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm transition-colors hover:border-primary/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Icon className="size-4 text-primary" />
              {title}
            </Link>
          ))}
        </div>
      </EmptyState>
    </div>
  )
}
