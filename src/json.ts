/** Readers for untyped JSON, such as a webhook payload or a plugin option: the value when it has the type, else nothing. */
export const str = (value: unknown) => (typeof value === "string" ? value : undefined)
export const num = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : undefined)
export const obj = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}
