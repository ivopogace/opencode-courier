import type { Plugin } from "@opencode/plugin"
import type { Pending } from "../courier.js"
import { describeFailure } from "../kernel/protocol.js"
import { REJECTED } from "./text.js"
import { answeringTop, type RosterStorage } from "../roster.js"

/** The answers to a permission request, as OpenCode's own prompt offers them. */
export const REPLIES = ["once", "always", "reject"] as const
export type Reply = (typeof REPLIES)[number]

/** A permission request, as OpenCode's `permission.asked` event carries it. */
export interface PermissionRequest {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly save?: ReadonlyArray<string>
  readonly message?: string
}

/**
 * What answering a permission request did; `answered` is false when no location loaded here held the
 * request: answered already, no longer waited for, or waiting in another server on the same data dir.
 */
export interface PermissionAnswered {
  readonly sessionID: string
  readonly requestID: string
  readonly reply: Reply
  readonly answered: boolean
}

type Context = Plugin.Context

/** One location's pending permission requests. OpenCode keeps them per location, so an isolated child's are in its worktree's. */
export type Permissions = Pick<Context["permission"], "list" | "reply">

/** The part of OpenCode's `permission.asked` event the notice is made from. */
export interface PermissionAsked {
  readonly id: string
  readonly data: PermissionRequest
}

/** The part of OpenCode's `permission.replied` event. */
export interface PermissionReplied {
  readonly id: string
  readonly data: { readonly sessionID: string; readonly requestID: string; readonly reply: Reply }
}

/**
 * Shared by every plugin instance in the process, like the handled event ids: the requests whose
 * notice went to a parent and that courier_answer has not answered yet.
 */
export type Waiting = Set<string>

export interface AnswerPorts {
  readonly storage: RosterStorage
  /** The permission domains of every loaded location; the request is answered where it is pending. */
  readonly permissions: () => Iterable<Permissions>
}

export interface AnswerInput {
  readonly sessionID: string
  readonly requestID: string
  readonly reply: string
  readonly message?: string
}

/** A session's pending requests in every location, with the domain holding each; a location that cannot be read gives its error. */
export function listEverywhere<D extends Pick<Permissions, "list">>(permissions: Iterable<D>, sessionID: string) {
  return Promise.all(
    [...permissions].map((domain) =>
      domain.list({ sessionID }).then(
        (requests) => ({ domain, requests: requests.filter((request) => request.sessionID === sessionID) }),
        (error: unknown) => ({ domain, requests: [], error }),
      ),
    ),
  )
}

/** Whether a session waits on a permission request of its own, in any loaded location. */
export async function asksPermission(ports: { readonly permissions: () => Iterable<Pick<Permissions, "list">> }, sessionID: string) {
  return (await listEverywhere([...ports.permissions()], sessionID)).some((found) => found.requests.length > 0)
}

/** The location holding a pending request, and the request; undefined when none does, and an error when one could not be read. */
async function locate(ports: AnswerPorts, sessionID: string, requestID: string) {
  const listed = await listEverywhere(ports.permissions(), sessionID)
  for (const { domain, requests } of listed) {
    const request = requests.find((item) => item.id === requestID)
    if (request) return { domain, request }
  }
  const failed = listed.find((item) => "error" in item)
  if (failed && "error" in failed) throw failed.error
  return undefined
}

/**
 * Answers a permission request of a session started, directly or through others, from the caller,
 * which must be the top session; `answered` is false when no location loaded here holds the request.
 */
export async function answer(ports: AnswerPorts, waiting: Waiting, callerID: string, input: AnswerInput): Promise<PermissionAnswered> {
  const reply = input.reply as Reply
  if (!REPLIES.includes(reply)) throw new Error(`reply must be once, always or reject, not "${input.reply}".`)
  const { sessionID, requestID } = input
  await answeringTop(ports.storage, sessionID, callerID, "permission requests")
  const found = await locate(ports, sessionID, requestID)
  if (!found) {
    waiting.delete(requestID)
    return { sessionID, requestID, reply, answered: false }
  }
  if (reply === "always" && !found.request.save?.length)
    throw new Error(`always is not offered for ${requestID}: it has nothing to save. Ask again with once or reject.`)
  // Off the waiting list first, so the reply event this answer causes does not come back as a notice.
  waiting.delete(requestID)
  const message = reply === "reject" ? input.message || REJECTED : undefined
  try {
    await found.domain.reply({ sessionID, requestID, decision: reply, ...(message ? { message } : {}) })
  } catch (error) {
    if (await locate(ports, sessionID, requestID).catch(() => found)) {
      waiting.add(requestID)
      throw error
    }
    throw new Error(
      `${describeFailure("permission.reply", error).message}, but ${requestID} no longer waits, so it was answered, possibly by this call.`,
    )
  }
  return { sessionID, requestID, reply, answered: true }
}

/** The requests a session waits on, in whichever location holds them, for courier_status. */
export async function pendingOf(permissions: Iterable<Permissions>, sessionID: string) {
  const found = new Map<string, Pending>()
  for (const { requests } of await listEverywhere(permissions, sessionID))
    for (const request of requests)
      found.set(request.id, {
        type: "permission",
        requestID: request.id,
        action: request.action,
        resources: [...request.resources],
        ...(request.save?.length ? { save: [...request.save] } : {}),
      })
  return [...found.values()]
}
