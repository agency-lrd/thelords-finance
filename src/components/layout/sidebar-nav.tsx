"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

import { navigation } from "@/config/navigation"

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {navigation.map((section) => (
        <div key={section.label} className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            {section.label}
          </p>
          {section.items.map((item) => {
            const active = isActive(pathname, item.href)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/75 transition-colors outline-none hover:bg-white/[0.04] hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent"
                )}
              >
                {active && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />
                )}
                <Icon
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-sidebar-foreground",
                    active && "text-sidebar-primary group-hover:text-sidebar-primary"
                  )}
                />
                {item.title}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
