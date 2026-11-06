import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

export type Storage = Pick<Context["storage"], "get" | "set" | "remove" | "scan">

export async function scanAll<T>(storage: Pick<Storage, "scan">, prefix: string) {
  return (await scanEntries<T>(storage, prefix)).map((entry) => entry.value)
}

export async function scanEntries<T>(storage: Pick<Storage, "scan">, prefix: string) {
  const entries: Array<{ key: string; value: T }> = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix, ...(after ? { after } : {}) })
    for (const entry of page.entries) entries.push({ key: entry.key.slice(prefix.length), value: entry.value as unknown as T })
    after = page.next
  } while (after)
  return entries
}

export type Registry = Record<symbol, unknown>

export function processWide<T>(key: string, create: () => T, registry: Registry = globalThis as Registry): T {
  const symbol = Symbol.for(key)
  registry[symbol] ??= create()
  return registry[symbol] as T
}
