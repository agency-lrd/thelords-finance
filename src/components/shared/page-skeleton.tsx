import { PageHeader } from "@/components/shared/page-header"

/** Static shell shown while the session and data load. */
export function PageSkeleton({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={title} description={description} />
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
        <div className="h-10 w-full animate-pulse rounded-lg bg-muted/30" />
        <div className="h-64 w-full animate-pulse rounded-xl bg-muted/20" />
      </div>
    </div>
  )
}

export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl bg-card/60 p-5 ring-1 ring-foreground/10 ${className}`}>{children}</div>
}
