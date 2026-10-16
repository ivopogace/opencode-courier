import { envelope } from "../kernel/protocol.js"
import { claim } from "../platform/bounded.js"
import type { EventModule, HostEvent } from "../platform/events.js"
import { allEntries, lineage, nativeRootOf } from "../tree/index.js"
import { reportForm, reportFormSettled, type FormCreated, type FormSettled } from "./form.js"
import { listEverywhere, type PermissionAsked, type PermissionReplied } from "./permission.js"
import { topOf, type PersonPorts, type PersonState } from "./ports.js"
import { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed, locationClosing } from "./question/index.js"
import { permissionNotice, permissionSettledNotice } from "./text.js"

/**
 * Tells the session at the top, the parent of a child or the session a chain of children started
 * from, what a waiting child asks and which answers there are, waking it. Returns the sessions told.
 */
export async function reportAsked(ports: PersonPorts, state: PersonState, event: PermissionAsked) {
  if (!claim(state.seen, event.id)) return []
  const request = event.data
  const chain = await lineage(ports.storage, request.sessionID)
  // Claimed only now, after the lookup: a request answered meanwhile is in `answered`, and one
  // already relayed, from the event or from the pending list, is in `waiting`.
  if (!chain.length || state.answered.has(request.id) || !claim(state.waiting, request.id)) return []
  const startedBy = chain.length > 1 ? chain[0]!.parentID : undefined
  // A native child's request shows as OpenCode's own prompt in its native root's view: when that is the top's, it is not asked again.
  const native = nativeRootOf(chain) === topOf(chain)
  await ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(request.sessionID, permissionNotice(chain[0]!.title, request, startedBy, native), {
      asks: "permission",
      request: request.id,
      ...(native ? { shown: "native" } : {}),
    }),
    description: `Session ${request.sessionID} asks for permission`,
    metadata: { source: "courier", from: request.sessionID, asks: "permission", requestID: request.id, ...(native ? { shown: "native" } : {}) },
    delivery: "steer",
  })
  return [topOf(chain)]
}

/**
 * Tells the session told about a request that it was answered some other way, so it does not pass on a stale
 * question; requests answered through courier_answer are skipped. Sent with `resume: false`, so it starts no turn.
 */
export async function reportReplied(ports: PersonPorts, state: PersonState, event: PermissionReplied) {
  if (!claim(state.seen, event.id)) return []
  const { sessionID, requestID, reply } = event.data
  if (!state.waiting.delete(requestID)) {
    claim(state.answered, requestID)
    return []
  }
  const chain = await lineage(ports.storage, sessionID)
  if (!chain.length) return []
  await ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(sessionID, permissionSettledNotice(chain[0]!.title, requestID, reply), { answered: reply, request: requestID }),
    description: `Session ${sessionID} no longer asks for permission`,
    metadata: { source: "courier", from: sessionID, answered: reply, requestID, resume: false },
    delivery: "steer",
    resume: false,
  })
  return [topOf(chain)]
}

/**
 * Relays the requests that spawned sessions already wait on, in every loaded location, which the
 * event stream does not repeat: those asked while it was down, before the watcher (re)subscribed.
 */
export async function relayPending(ports: PersonPorts, state: PersonState) {
  const sessions = new Set((await allEntries(ports.storage)).map((entry) => entry.sessionID))
  const domains = [...ports.permissions()]
  // Each request is claimed before its notice goes out, so relaying them all at once tells each
  // once, however many locations list it; a location that cannot be read lists none.
  const relay = async (sessionID: string) => {
    const listed = (await listEverywhere(domains, sessionID)).flatMap((found) => found.requests)
    await Promise.all(listed.map((request) => reportAsked(ports, state, { id: `pending:${request.id}`, data: request })))
  }
  await Promise.all([...sessions].map(relay))
}

/** The events of what a spawned session asks the person: permission requests, forms, and locations closing on them. */
function routePerson(ports: PersonPorts, state: PersonState, event: HostEvent) {
  if (event.type === "permission.asked") return reportAsked(ports, state, event as unknown as PermissionAsked)
  if (event.type === "permission.replied") return reportReplied(ports, state, event as unknown as PermissionReplied)
  if (event.type === "form.created") {
    // Not claimed: the hub's other subscription, or another copy's watcher, may resolve the same
    // waiting call, which is harmless.
    formShown(event as unknown as Parameters<typeof formShown>[0])
    return reportForm(ports, state, event as unknown as FormCreated)
  }
  if (event.type === "form.replied" || event.type === "form.cancelled")
    return reportFormSettled(ports, state, event as unknown as FormSettled)
  // Not claimed either: a location closing withdraws its forms, which must not pass for dismissals.
  // The event's location is optional; without one, the shutdown counts for every location.
  if (event.type === "location.shutdown") {
    const directory = (event as { location?: { directory?: unknown } }).location?.directory
    locationClosing(ports.now(), typeof directory === "string" ? directory : undefined)
  }
  return undefined
}

/**
 * Tells the top session of a spawned child's pending permission or form, relays the requests already
 * pending on every (re)subscribe, and tells the question relay when events are followed and when not.
 */
export function personEvents(state: PersonState): EventModule<PersonPorts> {
  return {
    handle: (ports, event) => routePerson(ports, state, event),
    // Question forms shown while no instance followed the events were not seen: released now,
    // and again on the first event, by when the stream is surely connected.
    followed: () => (eventsFollowed() ? formsMayHaveBeenMissed : undefined),
    // Alongside the new subscription; a request both relays see is relayed once.
    subscribed: (ports) => relayPending(ports, state).catch((error: unknown) => ports.log(`courier watch: could not relay pending requests: ${String(error)}`)),
    left: eventsLeft,
  }
}
