import type { Plugin } from "@opencode-ai/plugin"
import { envelope } from "./courier.js"
import { entriesOf, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** How long to wait before subscribing again after the event stream ended or broke. */
export const RESUBSCRIBE_MS = 5_000

/** How many handled event ids are remembered, to tell a repeat from a new failure. */
const SEEN_MAX = 1_000

export interface WatchPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  readonly event: Pick<Context["event"], "subscribe">
  readonly log: (message: string) => void
}

/** The part of OpenCode's `session.execution.failed` event the notice is made from. */
export interface ExecutionFailed {
  readonly id: string
  readonly data: {
    readonly sessionID: string
    readonly error: { readonly type: string; readonly message: string; readonly status?: number | undefined }
  }
}

export function failureNotice(title: string, error: ExecutionFailed["data"]["error"]) {
  const status = error.status === undefined ? "" : `, status ${error.status}`
  return [
    `This session, "${title}", which you started with courier_spawn, failed: ${error.message} (${error.type}${status}).`,
    "Its turn ended without finishing, so it will not report back on its own.",
    "Message it with courier_send to have it try again, start a replacement, or carry on without it.",
  ].join("\n")
}

/**
 * Tells the parent of a child whose turn failed, since a child that cannot reach its model cannot
 * call courier_send. Returns the parents told. OpenCode sets the plugin up once per project
 * location, all in one process, and each instance may see the same event, so the instances share
 * `seen`: an event id is claimed synchronously and handled once.
 */
export async function reportFailure(ports: WatchPorts, seen: Set<string>, event: ExecutionFailed) {
  if (seen.has(event.id)) return []
  seen.add(event.id)
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!)
  const { sessionID, error } = event.data
  const entries = await entriesOf(ports.storage, sessionID)
  for (const entry of entries)
    await ports.session.synthetic({
      sessionID: entry.parentID,
      text: envelope(sessionID, failureNotice(entry.title, error), { failed: error.type }),
      description: `Session ${sessionID} failed`,
      metadata: { source: "courier", from: sessionID, failed: true },
      delivery: "steer",
    })
  return entries.map((entry) => entry.parentID)
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
  })

/** Follows OpenCode's events until `signal` aborts, reporting each failed turn of a spawned child. */
export async function watchFailures(ports: WatchPorts, seen: Set<string>, signal: AbortSignal, retryMs = RESUBSCRIBE_MS) {
  while (!signal.aborted) {
    try {
      for await (const event of ports.event.subscribe({ signal })) {
        if (event.type !== "session.execution.failed") continue
        await reportFailure(ports, seen, event).catch((error: unknown) =>
          ports.log(`courier watch: could not report the failure of ${event.data.sessionID}: ${String(error)}`),
        )
      }
    } catch (error) {
      if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
    }
    if (!signal.aborted) await pause(retryMs, signal)
  }
}
