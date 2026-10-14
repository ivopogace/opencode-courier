import type { Plugin } from "@opencode/plugin"
import { describeFailure } from "../kernel/protocol.js"
import { REJECTED, refusedText } from "./text.js"
import { answeringTop, type Pending, type RosterStorage } from "../tree/index.js"

/** The answers to a permission request, as OpenCode's own prompt offers them. */
export const REPLIES = ["once", "always", "reject"] as const
export type Reply = (typeof REPLIES)[number]

/**
 * What courier_answer passes on: `once`, which OpenCode first asks the person about in the caller's
 * session, or `reject`. Never `always`: the plugin grants no standing rule to the caller or the child.
 */
export const PROPOSALS = ["once", "reject"] as const
export type Proposal = (typeof PROPOSALS)[number]

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

/** OpenCode's check of a session's permission rules, which asks the person in that session when they say so. */
export type Assert = Context["permission"]["assert"]

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
  /** The caller's location's check, which prompts the person in the caller's session. */
  readonly assert: Assert
}

/** The courier_answer call a proposal comes from, which OpenCode's prompt in the caller's session is bound to. */
export interface AnswerCall {
  readonly messageID: string
  readonly callID: string
}

export interface AnswerInput {
  readonly sessionID: string
  readonly requestID: string
  readonly reply: string
  readonly message?: string
  readonly call?: AnswerCall
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

const tagOf = (value: unknown) => (value as { _tag?: unknown } | undefined)?._tag

/**
 * Whether `permission.assert` failed because the person rejected the caller's prompt without a reason,
 * which OpenCode ends the caller's step on; the tool rethrows it as it is, and the child's request waits on.
 */
export const isDeclined = (error: unknown) => tagOf(error) === "Permission.DeclinedError"

/** Why `permission.assert` refused: the caller's rules deny the action, or the person rejected the prompt with a reason. */
function refusalOf(error: unknown) {
  if (tagOf(error) !== "Tool.Error") return undefined
  const { message, error: cause } = error as { message?: unknown; error?: unknown }
  const tag = tagOf(cause)
  if (tag !== "Permission.BlockedError" && tag !== "Permission.CorrectedError") return undefined
  return typeof message === "string" && message ? message : "not allowed"
}

/**
 * Has OpenCode check the child's request against the caller's session rules, which asks the person
 * there when they say so, with the request's own action and resources, never the model's words, and
 * nothing to save. Gives the reason when refused with one, nothing when allowed; a plain rejection
 * and any other failure are thrown.
 */
async function askCaller(ports: AnswerPorts, callerID: string, request: PermissionRequest, call?: AnswerCall) {
  try {
    await ports.assert({
      sessionID: callerID,
      action: request.action,
      resources: [...request.resources],
      metadata: { source: "courier", from: request.sessionID, asks: "permission", requestID: request.id },
      ...(call ? { source: { type: "tool", messageID: call.messageID, id: call.callID } } : {}),
    })
    return undefined
  } catch (error) {
    const reason = refusalOf(error)
    if (reason === undefined) throw error
    return reason
  }
}

/**
 * Answers a permission request of a session started, directly or through others, from the caller,
 * which must be the top session; `answered` is false when no location loaded here holds the request.
 * A proposed `once` is passed on only once OpenCode has allowed it in the caller's session.
 */
export async function answer(ports: AnswerPorts, waiting: Waiting, callerID: string, input: AnswerInput): Promise<PermissionAnswered> {
  const reply = input.reply as Proposal
  if (!PROPOSALS.includes(reply)) {
    const always = input.reply === "always" ? ": courier_answer grants no standing rule; the person grants one in OpenCode's own prompt, in the asking session or the asks inbox" : ""
    throw new Error(`reply must be once or reject, not "${input.reply}"${always}.`)
  }
  const { sessionID, requestID } = input
  await answeringTop(ports.storage, sessionID, callerID, "permission requests")
  let found = await locate(ports, sessionID, requestID)
  if (!found) {
    waiting.delete(requestID)
    return { sessionID, requestID, reply, answered: false }
  }
  let message = reply === "reject" ? input.message || REJECTED : undefined
  let refused: string | undefined
  if (reply === "once") {
    refused = await askCaller(ports, callerID, found.request, input.call)
    // Answered meanwhile, in the child's session or the asks inbox, while the person was asked.
    found = await locate(ports, sessionID, requestID)
    if (!found) {
      waiting.delete(requestID)
      return { sessionID, requestID, reply, answered: false }
    }
    if (refused !== undefined) message = refused
  }
  const decision = refused === undefined ? reply : "reject"
  // Off the waiting list first, so the reply event this answer causes does not come back as a notice.
  waiting.delete(requestID)
  try {
    await found.domain.reply({ sessionID, requestID, decision, ...(message ? { message } : {}) })
  } catch (error) {
    if (await locate(ports, sessionID, requestID).catch(() => found)) {
      waiting.add(requestID)
      throw error
    }
    throw new Error(
      `${describeFailure("permission.reply", error).message}, but ${requestID} no longer waits, so it was answered, possibly by this call.`,
    )
  }
  if (refused !== undefined) throw new Error(refusedText(sessionID, requestID, refused))
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
