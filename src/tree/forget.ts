import type { ReportKeys, RosterStorage, WatchPorts } from "./ports.js"
import { childStore } from "./store.js"

export async function forgetChild(storage: RosterStorage, parentID: string, sessionID: string) {
  await childStore(storage).remove(parentID, sessionID)
}

export async function forgetDeleted(ports: Pick<WatchPorts, "storage">, sessionID: string, forgotten: ReadonlyArray<string>) {
  const children = childStore(ports.storage)
  await Promise.all([...forgotten.map((id) => children.forgetReport(id)), children.forgetTyped(sessionID), children.forgetPassed(sessionID)])
}

export async function forgetReports(storage: RosterStorage, keys: ReportKeys, sessions: ReadonlyArray<string>) {
  await childStore(storage).dropReported(sessions.flatMap((sessionID) => keys.get(sessionID) ?? []))
}
