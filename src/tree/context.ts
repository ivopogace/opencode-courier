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
    const { depth, entry, subagent, hostReports } = await roleOf(ports, event.sessionID)
    const leaf = subagent || (depth !== null && depth >= ports.limits.maxDepth)
    if (leaf) delete event.tools.courier_spawn
    if (subagent || (depth === null && !event.tools.courier_spawn)) return
    if (entry || event.system.some((part) => ROLE_LINE.test(part.text))) return
    event.system.push({ type: "text", text: rolePart(depth, ports.limits, hostReports === true) })
  } catch (error) {
    ports.log(`courier: cannot tell the role of session ${event.sessionID}: ${String(error)}`)
  }
}

async function roleOf(ports: ContextPorts, sessionID: string, below: ReadonlySet<string> = new Set()): Promise<Role> {
  const known = ports.roles.get(sessionID)
  if (known !== undefined) return known
  const children = childStore(ports.storage)
  const [chain, started] = await Promise.all([children.indexedLineage(sessionID), children.children(sessionID)])
  const depth = chain.length || (started.length ? 0 : null)
  if (depth === null) {
    const { parentID } = await ports.session.get({ sessionID })
    if (parentID && !below.has(parentID)) {
      const above = await roleOf(ports, parentID, new Set([...below, sessionID]))
      if (above.depth === null && !above.subagent) return { depth: null, entry: false }
      const role: Role = { depth: null, entry: false, subagent: true }
      setBounded(ports.roles, sessionID, role, ROLES_MAX)
      return role
    }
  }
  const entry = depth !== null && (await hasEntry(ports, sessionID))
  const hostReports = depth !== null && !entry && (ports.nativeChildren === true || started.some((child) => child.native))
  const role: Role = { depth, entry, ...(hostReports ? { hostReports: true } : {}) }
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
