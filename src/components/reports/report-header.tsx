import { PeriodPicker } from "@/components/reports/period-picker"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/form-controls"
import type { PeriodKind } from "@/lib/reports/periods"

/** Report title, period switch and optional department/client filters (plain GET form). */
export function ReportHeader(props: {
  title: string
  description: string
  period?: string
  kinds?: PeriodKind[]
  filters?: {
    labels: { department: string; client: string; all: string; apply: string }
    departments?: { id: string; name: string }[]
    clients?: { id: string; name: string }[]
    departmentId: string | null
    clientId: string | null
  }
  actions?: React.ReactNode
}) {
  const f = props.filters
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-black uppercase tracking-tight sm:text-4xl">{props.title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{props.description}</p>
        </div>
        {props.actions}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {props.period && <PeriodPicker value={props.period} kinds={props.kinds} />}
        {f && (
          <form method="get" className="flex flex-wrap items-center gap-2">
            {props.period && <input type="hidden" name="p" value={props.period} />}
            {f.departments && (
              <Select name="dept" defaultValue={f.departmentId ?? ""} className="h-8 w-52" aria-label={f.labels.department}>
                <option value="">{f.labels.department}: {f.labels.all}</option>
                {f.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            )}
            {f.clients && (
              <Select name="client" defaultValue={f.clientId ?? ""} className="h-8 w-52" aria-label={f.labels.client}>
                <option value="">{f.labels.client}: {f.labels.all}</option>
                {f.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
            <Button type="submit" variant="outline" size="sm">{f.labels.apply}</Button>
          </form>
        )}
      </div>
    </div>
  )
}
