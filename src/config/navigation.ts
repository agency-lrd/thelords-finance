import {
  Activity,
  ArrowLeftRight,
  Building2,
  ChartColumn,
  FileSpreadsheet,
  FolderKanban,
  LayoutDashboard,
  Receipt,
  Scale,
  Settings,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
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
        description: "Team members, departments and salary history.",
      },
      {
        title: "Financial Sheet",
        href: "/payroll",
        icon: FileSpreadsheet,
        description: "Monthly employee financial sheet: salary, bonuses, deductions and net pay.",
      },
      {
        title: "Department Profit",
        href: "/departments",
        icon: Building2,
        description: "Revenue, project costs, payroll and profit by department.",
      },
    ],
  },
  {
    label: "Projects",
    items: [
      {
        title: "Projects",
        href: "/projects",
        icon: FolderKanban,
        description: "Client and internal projects with income, costs and margin.",
      },
      {
        title: "Project Income",
        href: "/project-income",
        icon: TrendingUp,
        description: "Revenue recorded against projects, by month.",
      },
      {
        title: "Project Costs",
        href: "/project-costs",
        icon: TrendingDown,
        description: "Direct costs recorded against projects, by month.",
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
  {
    label: "Administration",
    items: [
      {
        title: "Settings",
        href: "/settings",
        icon: Settings,
        description: "Departments, income and cost categories, and monthly exchange rates.",
      },
      {
        title: "Users & Access",
        href: "/admin/users",
        icon: ShieldCheck,
        description: "Grant and revoke roles for Supabase accounts.",
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
