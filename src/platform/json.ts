export const str = (value: unknown) => (typeof value === "string" ? value : undefined)
export const num = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : undefined)
export const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
export const obj = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {}

export function millis(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value === "string") return Date.parse(value)
  const epoch: unknown = obj(value).epochMilliseconds
  return typeof epoch === "number" ? epoch : Number.NaN
}

export const isNotFound = (error: unknown) => str(obj(error)._tag)?.includes("NotFound") ?? false
