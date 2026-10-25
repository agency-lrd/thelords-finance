import {
  Activity,
  ArrowLeftRight,
  Building2,
  ChartColumn,
  FileSpreadsheet,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Receipt,
  Sparkles,
  Crown,
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

/**
 * Main menu, ordered by daily use. Pages taken out of the menu (balance sheet, budgets, employees,
 * separate departments/categories, profitability) still exist and keep all their data; their
 * functions live in AI CFO, the financial sheet, Cash Flow and "Отделы и категории".
 */
export const navItems: NavItem[] = [
  { key: "aiCfo", href: "/ai-cfo", icon: Sparkles },
  { key: "dashboard", href: "/", icon: LayoutDashboard },
  { key: "sheet", href: "/payroll", icon: FileSpreadsheet },
  { key: "transactions", href: "/transactions", icon: ArrowLeftRight },
  { key: "pnl", href: "/pnl", icon: Receipt },
  { key: "cashFlow", href: "/cash-flow", icon: Activity },
  { key: "analytics", href: "/analytics", icon: ChartColumn },
  { key: "owners", href: "/owners", icon: Crown },
  { key: "structure", href: "/structure", icon: Building2 },
  { key: "accounts", href: "/accounts", icon: Landmark },
  { key: "vault", href: "/vault", icon: KeyRound },
]

/** Routes that still work but are not in the menu (reachable from links). */
export const hiddenRoutes = ["/balance-sheet", "/budgets", "/employees", "/departments", "/categories", "/profitability"]

export function getNavItem(href: string): NavItem {
  const item = navItems.find((entry) => entry.href === href)
  if (!item) throw new Error(`Unknown navigation route: ${href}`)
  return item
}
