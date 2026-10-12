// Run by test/hub.test.ts in a process of its own: loads the hub module twice, as two copies of the
// plugin in one process; kept out of the test process, whose Bun coverage one copy would overwrite.
import { deliverDue, type LaterPorts } from "../../src/later.js"
import type { Member, TickJob } from "../../src/platform/hub.js"

type HubModule = typeof import("../../src/platform/hub.js")
type EventsModule = typeof import("../../src/platform/events.js")
const copy = (name: string) => import(`../../src/platform/hub.js?copy=${name}`) as Promise<HubModule>
const eventsCopy = (name: string) => import(`../../src/platform/events.js?copy=${name}`) as Promise<EventsModule>
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
// Each copy opens the process's hub as its plugin module does, with its own jobs: none here.
const firstOpened = first.open(registry, [])
const secondOpened = second.open(registry, [])
const leaveA = firstOpened.join(member("/a"))
const loop = first.hub.scheduler.timer
const leaveB = secondOpened.join(member("/b"))
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
const skewedOpened = skewed.open(registry, [])
const leaveC = skewedOpened.join(member("/c", (message) => logs.push(message)))
const leaveD = skewedOpened.join(member("/d", (message) => logs.push(message)))
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
const delivering: TickJob[] = [(owner, claimed) => deliverDue(owner.later as LaterPorts, claimed)]
const olderCopy = first.open(own, delivering, timers, "server_a")
const newerCopy = second.open(own, delivering, timers, "server_a")
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

// Registration under skew: an older copy's instances /a, /b and /c, then a newer copy's /d, each copy
// registering its own tick jobs and event modules as its plugin module does. The newer copy, joined
// last, runs its own through the older copy's members: ticks through /a, the first loaded, and the
// subscription replacing /a's through /c, the earliest without one.
const ran: string[] = []
const registry2: Record<symbol, unknown> = {}
const keys = new Map<string, unknown>()
const runs2: Array<() => void> = []
const timers2 = { every: (run: () => void) => (runs2.push(run), runs2.length), stop: () => {}, wait: async () => {} }
const watching = (directory: string) => ({
  later: {
    storage: {
      get: async (key: string) => keys.get(key),
      set: async (key: string, value: unknown) => void keys.set(key, value),
      remove: async (key: string) => void keys.delete(key),
    },
    now: () => 1_000,
  },
  // The event stream yields one event, then stays open until its subscription is stopped.
  watch: {
    name: directory,
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        yield { type: "ping", data: {} }
        await new Promise((resolve) => signal.addEventListener("abort", resolve))
      },
    },
    log: () => {},
  },
  directory,
  permission: {},
  questions: {},
  log: () => {},
})
const registered = async (name: string) => {
  const hubCopy = await copy(`registered-${name}`)
  const events = await eventsCopy(`registered-${name}`)
  const opened = hubCopy.open(registry2, [async (owner) => void ran.push(`${name} job through ${owner.directory}`)], timers2, "server_r")
  const modules = [{ handle: async (ports: { name: string }, event: { type: string }) => void ran.push(`${name} ${event.type} through ${ports.name}`) }]
  return {
    load: (directory: string) => {
      events.watchFromHub(opened.hub, modules as never)
      return opened.join(watching(directory) as unknown as Member)
    },
    opened,
  }
}
const older = await registered("older")
const newer = await registered("newer")
const leaveRA = older.load("/a")
older.load("/b")
older.load("/c")
await settle()
const beforeNewer = ran.splice(0).sort()
newer.load("/d")
runs2.at(-1)!()
await settle()
await leaveRA()
await settle()
const shared2 = older.opened.hub
const registration = {
  sameHub: shared2 === newer.opened.hub,
  beforeNewer,
  afterNewer: ran,
  watchingThrough: shared2.watchers.map((watcher) => watcher.member.directory),
}
for (const watcher of shared2.watchers) watcher.stop.abort()

console.log(
  JSON.stringify({
    registration,
    otherCopy,
    sameHub: first.hub === second.hub,
    separateModules: first.open !== second.open && firstOpened.join !== secondOpened.join,
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
