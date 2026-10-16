import {
  Activity,
  ArrowLeftRight,
  Building2,
  ChartColumn,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  Receipt,
  Scale,
  Sparkles,
  Tags,
  Target,
  TrendingUp,
  Crown,
  Users,
  type LucideIcon,
} from "lucide-react"

import type { Dictionary } from "@/lib/i18n/dictionaries"

export type NavItem = {
  key: keyof Dictionary["nav"]
  href: string
  icon: LucideIcon
  /** Placeholder modules are shown with a "coming soon" marker. */
  soon?: boolean
}

export const navItems: NavItem[] = [
  { key: "dashboard", href: "/", icon: LayoutDashboard },
  { key: "sheet", href: "/payroll", icon: FileSpreadsheet },
  { key: "transactions", href: "/transactions", icon: ArrowLeftRight },
  { key: "pnl", href: "/pnl", icon: Receipt },
  { key: "cashFlow", href: "/cash-flow", icon: Activity },
  { key: "balanceSheet", href: "/balance-sheet", icon: Scale },
  { key: "profitability", href: "/profitability", icon: TrendingUp },
  { key: "analytics", href: "/analytics", icon: ChartColumn },
  { key: "budgets", href: "/budgets", icon: Target },
  { key: "owners", href: "/owners", icon: Crown },
  { key: "employees", href: "/employees", icon: Users },
  { key: "departments", href: "/departments", icon: Building2 },
  { key: "accounts", href: "/accounts", icon: Landmark },
  { key: "categories", href: "/categories", icon: Tags },
  { key: "aiCfo", href: "/ai-cfo", icon: Sparkles },
]

export function getNavItem(href: string): NavItem {
  const item = navItems.find((entry) => entry.href === href)
  if (!item) throw new Error(`Unknown navigation route: ${href}`)
  return item
}
