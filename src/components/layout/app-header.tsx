import { MobileNav } from "@/components/layout/mobile-nav"
import { Badge } from "@/components/ui/badge"

export function AppHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur supports-backdrop-filter:bg-background/60 sm:px-6">
      <MobileNav />
      <div className="ml-auto flex items-center gap-2">
        <Badge variant="outline" className="gap-1.5 text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/60" />
          No data source connected
        </Badge>
      </div>
    </header>
  )
}
