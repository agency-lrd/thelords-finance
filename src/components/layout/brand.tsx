import Link from "next/link"

import { siteConfig } from "@/config/site"

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3 px-2 outline-none">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-[0_0_24px_-4px_var(--primary)]">
        L
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-sm font-semibold tracking-[0.2em]">{siteConfig.name}</span>
        <span className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {siteConfig.product}
        </span>
      </span>
    </Link>
  )
}
