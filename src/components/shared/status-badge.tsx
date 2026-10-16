import { cn } from "cn"

const tone: Record<string, string> = {
  ACTIVE: "border-primary/40 text-primary",
  APPROVED: "border-primary/40 text-primary",
  PAID: "border-emerald-500/40 text-emerald-400",
  RECEIVED: "border-emerald-500/40 text-emerald-400",
  COMPLETED: "border-emerald-500/40 text-emerald-400",
  INVOICED: "border-sky-500/40 text-sky-300",
  INCURRED: "border-sky-500/40 text-sky-300",
  PARTIALLY_RECEIVED: "border-sky-500/40 text-sky-300",
  DRAFT: "border-border text-muted-foreground",
  CALCULATED: "border-border text-muted-foreground",
  PLANNED: "border-border text-muted-foreground",
  ONBOARDING: "border-border text-muted-foreground",
  ON_LEAVE: "border-amber-500/40 text-amber-300",
  ON_HOLD: "border-amber-500/40 text-amber-300",
  SUSPENDED: "border-amber-500/40 text-amber-300",
  TERMINATED: "border-destructive/40 text-destructive",
  CANCELLED: "border-destructive/40 text-destructive",
  WRITTEN_OFF: "border-destructive/40 text-destructive",
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap",
        tone[status] ?? "border-border text-muted-foreground",
        className,
      )}
    >
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  )
}
