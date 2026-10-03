import type { Plugin } from "@opencode-ai/plugin"

type Storage = Pick<Plugin.Context["storage"], "scan">

/** Every value stored under a prefix, following the scan's pages. */
export async function scanAll<T>(storage: Storage, prefix: string) {
  const values: T[] = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix, ...(after ? { after } : {}) })
    for (const entry of page.entries) values.push(entry.value as unknown as T)
    after = page.next
  } while (after)
  return values
}
