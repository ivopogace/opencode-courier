import { setBounded } from "../platform/bounded.js"
import type { ContextPorts, Role } from "./ports.js"
import { childStore } from "./store.js"
import { ROLE_KEY, ROLE_PREFIX, rolePart } from "./text.js"

const ROLES_MAX = 1000

const ROLE_LINE = new RegExp(`^${ROLE_PREFIX}`, "m")

export interface Shaped {
  readonly sessionID: string
  tools: Record<string, unknown>
  system: Array<{ type: "text"; text: string }>
}

export async function shapeContext(ports: ContextPorts, event: Shaped) {
  try {
    const { depth, entry } = await roleOf(ports, event.sessionID)
    if (depth === null && !event.tools.courier_spawn) return
    if (depth !== null && depth >= ports.limits.maxDepth) for (const tool of ["courier_spawn", ...(ports.hiddenFromLeaf ?? [])]) delete event.tools[tool]
    if (entry || event.system.some((part) => ROLE_LINE.test(part.text))) return
    event.system.push({ type: "text", text: rolePart(depth, ports.limits) })
  } catch (error) {
    ports.log(`courier: cannot tell the role of session ${event.sessionID}: ${String(error)}`)
  }
}

async function roleOf(ports: ContextPorts, sessionID: string): Promise<Role> {
  const known = ports.roles.get(sessionID)
  if (known !== undefined) return known
  const children = childStore(ports.storage)
  const chain = await children.indexedLineage(sessionID)
  const depth = chain.length || ((await children.children(sessionID)).length ? 0 : null)
  const role = { depth, entry: depth !== null && (await hasEntry(ports, sessionID)) }
  setBounded(ports.roles, sessionID, role, ROLES_MAX)
  return role
}

async function hasEntry(ports: ContextPorts, sessionID: string) {
  if (!ports.instructions) return false
  try {
    return (await ports.instructions.entry.list({ sessionID })).some((entry) => entry.key === ROLE_KEY)
  } catch (error) {
    ports.log(`courier: cannot read the instruction entries of session ${sessionID}, so its role goes in a system part: ${String(error)}`)
    return false
  }
}
