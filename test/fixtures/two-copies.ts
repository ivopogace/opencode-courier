// Run by test/hub.test.ts in a process of its own: loads the hub module twice, as two copies of the
// plugin in one process; kept out of the test process, whose Bun coverage one copy would overwrite.
import type { Member } from "../../src/hub.js"

type HubModule = typeof import("../../src/hub.js")
const copy = (name: string) => import(`../../src/hub.js?copy=${name}`) as Promise<HubModule>
const registry = globalThis as Record<symbol, unknown>

// The reads of the scheduler's owner key, by the directory of the member they ran through: the first
// thing a tick does, at once as it starts. (A last leave's release reads it later, after the tick.)
const ownerReads: string[] = []
const later = (directory: string) => ({
  storage: {
    get: async () => void ownerReads.push(directory),
    set: async () => {},
    remove: async () => {},
    scan: async () => ({ entries: [] }),
  },
  now: () => 0,
  log: () => {},
})
const member = (directory: string, log: (message: string) => void = () => {}) =>
  ({ directory, permission: { directory }, later: later(directory), watch: {}, questions: {}, log }) as unknown as Member

const first = await copy("1")
const second = await copy("2")
const leaveA = first.join(member("/a"))
const loop = first.hub.scheduler.timer
const leaveB = second.join(member("/b"))
const joined = { members: [...first.hub.members].map((m) => m.directory), permissions: [...second.permissions()].length }
// The second copy joins the loop the first one started rather than starting its own.
const oneLoop = loop !== undefined && second.hub.scheduler.timer === loop
leaveA()
const afterLeave = [...second.hub.members].map((m) => m.directory)
const loopKept = second.hub.scheduler.timer === loop
leaveB()
const emptyAtEnd = first.hub.members.size === 0 && first.hub.locations.size === 0 && first.hub.scheduler.timer === undefined

// A copy of this hub version loaded after one of another version took the key.
registry[Symbol.for(first.HUB_KEY)] = { version: first.HUB_VERSION + 1 }
const logs: string[] = []
const skewed = await copy("skewed")
const leaveC = skewed.join(member("/c", (message) => logs.push(message)))
const leaveD = skewed.join(member("/d", (message) => logs.push(message)))
// A hub of its own runs a loop of its own.
const skewedOwnLoop = skewed.hub.scheduler.timer !== undefined
leaveC()
leaveD()

// A tick the first copy started, still delivering, keeps the owner key renewed by the second copy's
// ticks for a minute, and the second's last leave waits for it; own registry, timers fired by hand.
const store = new Map<string, unknown>()
let now = 1_000
let finish = () => {}
const runs: Array<() => void> = []
// The first tick's wait before reading the key back ends at once; a leave's own wait never does.
let waits = 0
const timers = {
  every: (run: () => void) => (runs.push(run), runs.length),
  stop: () => {},
  wait: () => (waits++ === 0 ? Promise.resolve() : new Promise<void>(() => {})),
}
const stored = (directory: string, deliver?: () => Promise<unknown>) =>
  ({
    directory,
    permission: { directory },
    later: {
      storage: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => void store.set(key, value),
        remove: async (key: string) => void store.delete(key),
        scan: async ({ prefix }: { prefix: string }) => ({
          entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        }),
      },
      session: { synthetic: deliver ?? (async () => ({ id: "msg_1" })) },
      now: () => now,
      newID: () => "later_new",
      log: () => {},
    },
    watch: {},
    questions: {},
    log: () => {},
  }) as unknown as Member
const settle = () => Bun.sleep(1)
store.set("later/later_1", { id: "later_1", sessionID: "ses_parent", from: "ses_parent", message: "wake", fireAt: 1, createdAt: 0 })
const own: Record<symbol, unknown> = {}
const olderCopy = first.open(own, timers, "server_a")
const newerCopy = second.open(own, timers, "server_a")
const leaveOlder = olderCopy.join(stored("/a", () => new Promise((resolve) => (finish = () => resolve({ id: "msg_1" })))))
await settle()
const leaveNewer = newerCopy.join(stored("/b"))
const renewedAt: number[] = []
for (const step of [1, 2, 3, 4]) {
  now = 1_000 + step * first.OWNER_EXPIRY_MS / 4
  runs.at(-1)!()
  await settle()
  renewedAt.push((store.get(first.OWNER_KEY) as { at: number }).at)
}
void leaveOlder()
let left = false
void leaveNewer().then(() => (left = true))
await settle()
const heldWhileDelivering = store.has(first.OWNER_KEY) && !left
finish()
await settle()
const otherCopy = { renewedAt, heldWhileDelivering, releasedAfter: !store.has(first.OWNER_KEY) && left }

console.log(
  JSON.stringify({
    otherCopy,
    sameHub: first.hub === second.hub,
    separateModules: first.join !== second.join,
    joined,
    oneLoop,
    afterLeave,
    loopKept,
    emptyAtEnd,
    skewedOwnLoop,
    ownerReads,
    skewedOwnHub: skewed.hub !== first.hub && registry[Symbol.for(`${first.HUB_KEY}@${first.HUB_VERSION}`)] === skewed.hub,
    skewedSharesClaims: skewed.hub.claimed === first.hub.claimed && skewed.hub.questions === first.hub.questions,
    logs: logs.length,
  }),
)
