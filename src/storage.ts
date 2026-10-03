import type { Plugin } from "@opencode-ai/plugin"

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
