import { envelope } from "../kernel/protocol.js"
import { claim } from "../platform/bounded.js"
import type { EventModule, EventType, HostEvent } from "../platform/events.js"
import { allEntries, lineage, nativeRootOf } from "../tree/index.js"
import { reportForm, reportFormSettled, type FormCreated, type FormSettled } from "./form.js"
import { listEverywhere, type PermissionAsked, type PermissionReplied } from "./permission.js"
import { topOf, type PersonPorts, type PersonState } from "./ports.js"
import { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed, locationClosing } from "./question/index.js"
import { permissionNotice, permissionSettledNotice } from "./text.js"

export async function reportAsked(ports: PersonPorts, state: PersonState, event: PermissionAsked) {
  if (!claim(state.seen, event.id)) return []
  const request = event.data
  const chain = await lineage(ports.storage, request.sessionID)
  if (!chain.length || state.answered.has(request.id) || !claim(state.waiting, request.id)) return []
  const startedBy = chain.length > 1 ? chain[0]!.parentID : undefined
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

export async function relayPending(ports: PersonPorts, state: PersonState) {
  const sessions = new Set((await allEntries(ports.storage)).map((entry) => entry.sessionID))
  const domains = [...ports.permissions()]
  const relay = async (sessionID: string) => {
    const listed = (await listEverywhere(domains, sessionID)).flatMap((found) => found.requests)
    await Promise.all(listed.map((request) => reportAsked(ports, state, { id: `pending:${request.id}`, data: request })))
  }
  await Promise.all([...sessions].map(relay))
}

const PERSON_TYPES = ["permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled", "location.shutdown"] as const satisfies readonly EventType[]

function routePerson(ports: PersonPorts, state: PersonState, event: HostEvent) {
  if (event.type === "permission.asked") return reportAsked(ports, state, event as unknown as PermissionAsked)
  if (event.type === "permission.replied") return reportReplied(ports, state, event as unknown as PermissionReplied)
  if (event.type === "form.created") {
    formShown(event as unknown as Parameters<typeof formShown>[0])
    return reportForm(ports, state, event as unknown as FormCreated)
  }
  if (event.type === "form.replied" || event.type === "form.cancelled")
    return reportFormSettled(ports, state, event as unknown as FormSettled)
  if (event.type === "location.shutdown") {
    const directory = (event as { location?: { directory?: unknown } }).location?.directory
    locationClosing(ports.now(), typeof directory === "string" ? directory : undefined)
  }
  return undefined
}

export function personEvents(state: PersonState): EventModule<PersonPorts> {
  return {
    types: PERSON_TYPES,
    handle: (ports, event) => routePerson(ports, state, event),
    followed: () => (eventsFollowed() ? formsMayHaveBeenMissed : undefined),
    subscribed: (ports) => relayPending(ports, state).catch((error: unknown) => ports.log(`courier watch: could not relay pending requests: ${String(error)}`)),
    left: eventsLeft,
  }
}
