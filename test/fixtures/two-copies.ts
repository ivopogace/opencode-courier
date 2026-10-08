// Run by test/hub.test.ts in a process of its own: loads the hub module twice, as two copies of the
// plugin in one process, and prints what each saw. Kept out of the test process because Bun reports
// a file's coverage from one of its module instances, and a second copy's would replace the first's.
import type { Member } from "../../src/hub.js"

type HubModule = typeof import("../../src/hub.js")
const copy = (name: string) => import(`../../src/hub.js?copy=${name}`) as Promise<HubModule>
const registry = globalThis as Record<symbol, unknown>

const member = (directory: string, log: (message: string) => void = () => {}) =>
  ({ directory, permission: { directory }, later: {}, watch: {}, questions: {}, log }) as unknown as Member

const first = await copy("1")
const second = await copy("2")
const leaveA = first.join(member("/a"))
const leaveB = second.join(member("/b"))
const joined = { members: [...first.hub.members].map((m) => m.directory), permissions: [...second.permissions()].length }
leaveA()
const afterLeave = [...second.hub.members].map((m) => m.directory)
leaveB()
const emptyAtEnd = first.hub.members.size === 0 && first.hub.locations.size === 0

// A copy of this hub version loaded after one of another version took the key.
registry[Symbol.for(first.HUB_KEY)] = { version: first.HUB_VERSION + 1 }
const logs: string[] = []
const skewed = await copy("skewed")
skewed.join(member("/c", (message) => logs.push(message)))
skewed.join(member("/d", (message) => logs.push(message)))

console.log(
  JSON.stringify({
    sameHub: first.hub === second.hub,
    separateModules: first.join !== second.join,
    joined,
    afterLeave,
    emptyAtEnd,
    skewedOwnHub: skewed.hub !== first.hub && registry[Symbol.for(`${first.HUB_KEY}@${first.HUB_VERSION}`)] === skewed.hub,
    skewedSharesClaims: skewed.hub.claimed === first.hub.claimed && skewed.hub.questions === first.hub.questions,
    logs: logs.length,
  }),
)
