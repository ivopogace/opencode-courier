import { envelope } from "../kernel/protocol.js"
import { claim } from "../platform/bounded.js"
import type { ForkPorts } from "./ports.js"
import { childStore } from "./store.js"
import { forkNotice, ROLE_KEY, STANDING_KEY } from "./text.js"

export interface Forked {
  readonly sessionID: string
}

const OWN_KEYS: ReadonlyArray<string> = [ROLE_KEY, STANDING_KEY]

const startedBy = (metadata: unknown) => {
  const courier = (metadata as { courier?: { parentID?: unknown } } | null | undefined)?.courier
  return typeof courier?.parentID === "string" ? courier.parentID : undefined
}

async function ownEntries(ports: ForkPorts, sessionID: string) {
  const entries = ports.session.instructions?.entry
  if (!entries) return []
  try {
    return (await entries.list({ sessionID })).map((entry) => entry.key).filter((key) => OWN_KEYS.includes(key))
  } catch (error) {
    ports.log(`courier fork: cannot read the instruction entries of ${sessionID}: ${String(error)}`)
    return []
  }
}

async function hasChildren(ports: ForkPorts, originalID: string | undefined) {
  if (!originalID) return false
  try {
    return (await childStore(ports.storage).children(originalID)).length > 0
  } catch (error) {
    ports.log(`courier fork: cannot read the roster of ${originalID}: ${String(error)}`)
    return false
  }
}

async function tellFork(ports: ForkPorts, seen: Set<string>, sessionID: string) {
  const info = await ports.session.get({ sessionID })
  const originalID = info.fork?.sessionID
  const parentID = startedBy(info.metadata)
  const [keys, started] = await Promise.all([ownEntries(ports, sessionID), hasChildren(ports, originalID)])
  if (parentID === undefined && !keys.length && !started) return false
  if (!claim(seen, `fork/${sessionID}`)) return false
  const entries = ports.session.instructions?.entry
  await Promise.all(
    keys.map((key) =>
      entries
        ?.remove({ sessionID, key })
        .catch((error: unknown) => ports.log(`courier fork: the ${key} entry of ${sessionID} could not be removed, so the fork still reads it: ${String(error)}`)),
    ),
  )
  await ports.session.synthetic({
    sessionID,
    text: envelope("courier", forkNotice(originalID, parentID, started || keys.includes(STANDING_KEY)), { notice: "fork", ...(originalID ? { of: originalID } : {}) }),
    description: "Courier fork notice",
    metadata: { source: "courier", notice: "fork", ...(originalID ? { of: originalID } : {}), resume: false },
    resume: false,
  })
  return true
}

export async function onFork(ports: ForkPorts, seen: Set<string>, forked: Forked) {
  try {
    return await tellFork(ports, seen, forked.sessionID)
  } catch (error) {
    ports.log(`courier fork: could not tell ${forked.sessionID} that courier did not start it: ${String(error)}`)
    return false
  }
}
