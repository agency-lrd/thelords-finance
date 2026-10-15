import {
  Activity,
  ArrowLeftRight,
  Banknote,
  Building2,
  ChartColumn,
  LayoutDashboard,
  Receipt,
  Scale,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react"

export type NavItem = {
  title: string
  href: string
  icon: LucideIcon
  description: string
}

export type NavSection = {
  label: string
  items: NavItem[]
}

export const navigation: NavSection[] = [
  {
    label: "Overview",
    items: [
      {
        title: "Dashboard",
        href: "/",
        icon: LayoutDashboard,
        description: "Company-wide financial overview.",
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        title: "Employees",
        href: "/employees",
        icon: Users,
        description: "Team members, roles and compensation records.",
      },
      {
        title: "Payroll",
        href: "/payroll",
        icon: Banknote,
        description: "Payroll runs, salaries, bonuses and deductions.",
      },
      {
        title: "Departments",
        href: "/departments",
        icon: Building2,
        description: "Cost centers, headcount and departmental budgets.",
      },
    ],
  },
  {
    label: "Accounting",
    items: [
      {
        title: "Transactions",
        href: "/transactions",
        icon: ArrowLeftRight,
        description: "Income and expense ledger across all accounts.",
      },
      {
        title: "P&L",
        href: "/pnl",
        icon: Receipt,
        description: "Profit and loss statement by period.",
      },
      {
        title: "Cash Flow",
        href: "/cash-flow",
        icon: Activity,
        description: "Operating, investing and financing cash movements.",
      },
      {
        title: "Balance Sheet",
        href: "/balance-sheet",
        icon: Scale,
        description: "Assets, liabilities and equity at a point in time.",
      },
    ],
  },
  {
    label: "Intelligence",
    items: [
      {
        title: "Analytics",
        href: "/analytics",
        icon: ChartColumn,
        description: "Trends, ratios and performance breakdowns.",
      },
      {
        title: "AI CFO",
        href: "/ai-cfo",
        icon: Sparkles,
        description: "AI-assisted financial analysis and recommendations.",
      },
    ],
  },
]

export const navItems: NavItem[] = navigation.flatMap((section) => section.items)

export function getNavItem(href: string): NavItem {
  const item = navItems.find((entry) => entry.href === href)
  if (!item) throw new Error(`Unknown navigation route: ${href}`)
  return item
}
