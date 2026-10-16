/** Result of a Server Action used with useActionState. */
export type ActionState = {
  status: "idle" | "success" | "error"
  message?: string
}

export const idleState: ActionState = { status: "idle" }

/** Thrown by data functions for user-facing validation problems. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserInputError"
  }
}

export function text(formData: FormData, name: string, { required = false, max = 200 } = {}) {
  const value = String(formData.get(name) ?? "").trim()
  if (required && !value) throw new UserInputError(`${label(name)} is required.`)
  if (value.length > max) throw new UserInputError(`${label(name)} is too long (max ${max} characters).`)
  return value || null
}

export function requiredText(formData: FormData, name: string, max = 200) {
  return text(formData, name, { required: true, max }) as string
}

export function oneOf<T extends string>(formData: FormData, name: string, allowed: readonly T[]): T {
  const value = String(formData.get(name) ?? "")
  if (!allowed.includes(value as T)) throw new UserInputError(`Choose a valid ${label(name).toLowerCase()}.`)
  return value as T
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function optionalId(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "").trim()
  if (!value) return null
  if (!UUID.test(value)) throw new UserInputError(`Invalid ${label(name).toLowerCase()}.`)
  return value
}

export function requiredId(formData: FormData, name: string) {
  const value = optionalId(formData, name)
  if (!value) throw new UserInputError(`${label(name)} is required.`)
  return value
}

export function isoDate(formData: FormData, name: string, { required = true } = {}) {
  const value = String(formData.get(name) ?? "").trim()
  if (!value) {
    if (required) throw new UserInputError(`${label(name)} is required.`)
    return null
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new UserInputError(`${label(name)} must be a valid date.`)
  }
  return new Date(`${value}T00:00:00Z`)
}

function label(name: string) {
  const words = name.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Maps thrown errors to a safe message: validation and authorization text is shown, anything else is generic. */
export function toActionError(error: unknown): ActionState {
  if (error instanceof Error && (error.name === "UserInputError" || error.name === "AuthorizationError")) {
    return { status: "error", message: error.message }
  }
  const dbMessage = error instanceof Error ? databaseRuleMessage(error.message) : null
  if (dbMessage) return { status: "error", message: dbMessage }
  console.error(error)
  return { status: "error", message: "Something went wrong. Nothing was saved." }
}

/** Database integrity rules raise readable messages; surface the known ones. */
function databaseRuleMessage(message: string) {
  const rules: [RegExp, string][] = [
    [/is (CLOSED|LOCKED); its data cannot be changed/, "This month is closed. Its records can no longer be changed."],
    [/Overlapping validity period/, "This overlaps an existing record for the same dates."],
    [/payslips can no longer be changed/, "This month's sheet is approved and can no longer be changed."],
    [/Unique constraint failed|duplicate key value/, "A record with the same code or number already exists."],
    [/allocation would exceed 100%/, "Department allocations would exceed 100%."],
    [/lacks permission/, "You do not have permission to do this."],
  ]
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? null
}
