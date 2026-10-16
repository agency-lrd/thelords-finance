import type * as React from "react"
import { cn } from "cn"

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  )
}

export function THead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("bg-white/[0.02] [&_tr]:border-b [&_tr]:border-border", className)} {...props} />
}

export function TBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
}

export function TFoot({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot className={cn("border-t border-border bg-white/[0.03] font-medium", className)} {...props} />
}

export function TR({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border/60 transition-colors hover:bg-white/[0.02]", className)} {...props} />
}

export function TH({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-[0.12em] whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export function TD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />
}

/** Right-aligned tabular numbers for money columns. */
export function NumTD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-2.5 text-right align-middle font-mono text-[13px] tabular-nums whitespace-nowrap", className)} {...props} />
}
