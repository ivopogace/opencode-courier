/** Readers for untyped JSON, such as a webhook payload or a plugin option: the value when it has the type, else nothing. */
export const str = (value: unknown) => (typeof value === "string" ? value : undefined)
export const num = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : undefined)
export const obj = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}

/** Epoch milliseconds from a session time, a `DateTime` in OpenCode's API and a number in tests; NaN for none. */
export function millis(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value === "string") return Date.parse(value)
  const epoch: unknown = obj(value).epochMilliseconds
  return typeof epoch === "number" ? epoch : Number.NaN
}

/** Whether an error of OpenCode's says that what it names, such as a session, does not exist (`Session.NotFoundError`). */
export const isNotFound = (error: unknown) => str(obj(error)._tag)?.includes("NotFound") ?? false
