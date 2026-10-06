import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

export type Storage = Pick<Context["storage"], "get" | "set" | "remove" | "scan">

/** Every value stored under `prefix`, following the scan's pages. */
export async function scanAll<T>(storage: Pick<Storage, "scan">, prefix: string) {
  const values: T[] = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix, ...(after ? { after } : {}) })
    for (const entry of page.entries) values.push(entry.value as unknown as T)
    after = page.next
  } while (after)
  return values
}

/**
 * The one value the whole process keeps under `Symbol.for(key)`, made by `create` the first time,
 * so every instance of the plugin, and every copy of it loaded later, gets the same one.
 */
export function processWide<T>(key: string, create: () => T): T {
  const registry = globalThis as Record<symbol, unknown>
  const symbol = Symbol.for(key)
  registry[symbol] ??= create()
  return registry[symbol] as T
}
