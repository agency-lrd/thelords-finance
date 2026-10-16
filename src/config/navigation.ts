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
  { key: "employees", href: "/employees", icon: Users },
  { key: "departments", href: "/departments", icon: Building2 },
  { key: "accounts", href: "/accounts", icon: Landmark },
  { key: "transactions", href: "/transactions", icon: ArrowLeftRight, soon: true },
  { key: "pnl", href: "/pnl", icon: Receipt, soon: true },
  { key: "cashFlow", href: "/cash-flow", icon: Activity, soon: true },
  { key: "balanceSheet", href: "/balance-sheet", icon: Scale, soon: true },
  { key: "analytics", href: "/analytics", icon: ChartColumn, soon: true },
  { key: "aiCfo", href: "/ai-cfo", icon: Sparkles, soon: true },
]

export function getNavItem(href: string): NavItem {
  const item = navItems.find((entry) => entry.href === href)
  if (!item) throw new Error(`Unknown navigation route: ${href}`)
  return item
}
