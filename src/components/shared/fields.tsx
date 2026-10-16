import { Field, Input, Select } from "@/components/ui/form-controls"
import { SUPPORTED_CURRENCIES } from "@/lib/money"

/** Amount + currency + optional FX rate inputs used by financial forms. */
export function MoneyFields({ prefix = "", amountLabel = "Amount", defaultCurrency = "USD", withFx = true }: { prefix?: string; amountLabel?: string; defaultCurrency?: string; withFx?: boolean }) {
  return (
    <>
      <Field label={amountLabel} htmlFor={`${prefix}amount`}>
        <Input id={`${prefix}amount`} name="amount" inputMode="decimal" placeholder="0.00" required />
      </Field>
      <CurrencyField id={`${prefix}currency`} defaultValue={defaultCurrency} />
      {withFx && (
        <Field label="FX rate to USD" htmlFor={`${prefix}fxRate`} hint="Leave empty to use the month's saved rate.">
          <Input id={`${prefix}fxRate`} name="fxRate" inputMode="decimal" placeholder="auto" />
        </Field>
      )}
    </>
  )
}

export function CurrencyField({ id = "currency", name = "currency", label = "Currency", defaultValue = "USD" }: { id?: string; name?: string; label?: string; defaultValue?: string }) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} name={name} defaultValue={defaultValue}>
        {SUPPORTED_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
    </Field>
  )
}

export function SalaryFields({ prefix = "" }: { prefix?: string }) {
  return (
    <>
      <Field label="Pay basis" htmlFor={`${prefix}payBasis`}>
        <Select id={`${prefix}payBasis`} name="payBasis" defaultValue="MONTHLY">
          <option value="MONTHLY">Monthly salary</option>
          <option value="FIXED_FEE">Fixed monthly fee</option>
          <option value="HOURLY">Hourly rate</option>
          <option value="DAILY">Daily rate</option>
        </Select>
      </Field>
      <Field label="Amount" htmlFor={`${prefix}baseAmount`}>
        <Input id={`${prefix}baseAmount`} name="baseAmount" inputMode="decimal" placeholder="0.00" required />
      </Field>
      <CurrencyField id={`${prefix}currency`} />
      <Field label="Standard hours / month" htmlFor={`${prefix}standardHoursPerMonth`} hint="Hourly/daily pay only.">
        <Input id={`${prefix}standardHoursPerMonth`} name="standardHoursPerMonth" inputMode="decimal" placeholder="e.g. 160" />
      </Field>
    </>
  )
}

export function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
}
