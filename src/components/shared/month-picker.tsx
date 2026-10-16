import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/form-controls"
import { monthKey, type Month } from "@/lib/period"

/** GET form that switches the page's month (?month=YYYY-MM); works without JavaScript. */
export function MonthPicker({ month, name = "month", label = "Month", extra }: { month: Month; name?: string; label?: string; extra?: Record<string, string> }) {
  return (
    <form className="flex items-center gap-2" method="get">
      {extra && Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label htmlFor={`picker-${name}`} className="sr-only">
        {label}
      </label>
      <Input id={`picker-${name}`} type="month" name={name} defaultValue={monthKey(month)} className="h-8 w-40" required />
      <Button type="submit" variant="outline" size="sm">
        Show
      </Button>
    </form>
  )
}
