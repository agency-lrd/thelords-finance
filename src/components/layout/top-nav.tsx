"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "cn"

import { navItems } from "@/config/navigation"
import { useI18n } from "@/lib/i18n/client"

export function TopNav() {
  const pathname = usePathname()
  const { t } = useI18n()
  return (
    <nav aria-label="Main" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-3 [scrollbar-width:none]">
      {navItems.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full border px-4 py-1.5 text-[15px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-primary/70 bg-primary/10 text-primary shadow-[0_0_24px_-8px_var(--primary)]"
                : "border-transparent text-foreground/75 hover:text-foreground",
              item.soon && !active && "text-foreground/45",
            )}
          >
            {t.nav[item.key]}
          </Link>
        )
      })}
    </nav>
  )
}
