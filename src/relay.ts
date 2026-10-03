import type { Plugin } from "@opencode-ai/plugin"
import type { Pending } from "./courier.js"
import { entriesOf, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** One location's pending permission requests. OpenCode keeps them per location, so an isolated child's are in its worktree's. */
export type Permissions = Pick<Context["permission"], "list" | "get" | "reply">

/** The answers to a permission request, as OpenCode's own prompt offers them. */
export const REPLIES = ["once", "always", "reject"] as const
export type Reply = (typeof REPLIES)[number]

/**
 * Sent with a rejection that has no reason of its own. OpenCode ends the child's turn on a bare
 * rejection, and the child would never report back; with a message, the call fails and it carries on.
 */
export const REJECTED = "Refused by the session that started you. Do without it, or report back why you cannot."

const MAX_RESOURCES = 20
const MAX_RESOURCE_LENGTH = 300

/** The part of OpenCode's `permission.asked` event the notice is made from. */
export interface PermissionAsked {
  readonly id: string
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string> | undefined
    readonly message?: string | undefined
  }
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

const clip = (text: string) => (text.length > MAX_RESOURCE_LENGTH ? `${text.slice(0, MAX_RESOURCE_LENGTH - 3)}...` : text)

function alwaysChoice(request: PermissionAsked["data"]) {
  const save = request.save ?? []
  if (!save.length) return []
  const scope = save.length === 1 && save[0] === "*" ? `every ${request.action} request` : `requests matching ${save.join(", ")}`
  return [`- always: allow it, and from now on ${scope} in this project`]
}

export function permissionNotice(title: string, request: PermissionAsked["data"], startedBySession: boolean) {
  const resources = request.resources.slice(0, MAX_RESOURCES).map((resource) => `- ${clip(resource)}`)
  if (request.resources.length > MAX_RESOURCES) resources.push(`- and ${request.resources.length - MAX_RESOURCES} more`)
  return [
    `This session, "${title}", which you started with courier_spawn, is waiting for permission and does nothing until it is answered.`,
    `It asks for: ${request.action}`,
    ...(resources.length ? ["On:", ...resources] : []),
    ...(request.message ? [`Note: ${request.message}`] : []),
    "",
    "Do not decide this yourself. Ask the person you are working with (with your question tool, if you have one), offering exactly these choices:",
    "- once: allow this request only",
    ...alwaysChoice(request),
    "- reject: refuse it, with a reason if they give one; the session's call fails and it carries on",
    `When they have chosen, call courier_answer with sessionID "${request.sessionID}", requestID "${request.id}", reply set to their choice and, with reject, message set to their reason.`,
    ...(startedBySession
      ? [
          "You were started with courier_spawn yourself: if nobody is with you, ask the session that started you with courier_send instead, with the same choices, and answer with what it chose.",
        ]
      : []),
  ].join("\n")
}

export function settledNotice(title: string, requestID: string, reply: Reply) {
  return [
    `The permission request ${requestID} of this session, "${title}", has been answered (${reply}) without courier_answer, so it no longer waits on you.`,
    "If you asked someone about it, tell them it is settled; there is nothing to pass on.",
    ...(reply === "reject"
      ? [
          "A refusal without a reason ends the session's turn, and then it does not report back on its own: if it stays quiet, message it with courier_send to have it carry on.",
        ]
      : []),
  ].join("\n")
}

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

async function holderOf(ports: AnswerPorts, sessionID: string, requestID: string) {
  for (const permissions of ports.permissions())
    if (await permissions.get({ sessionID, requestID }).then(() => true, () => false)) return permissions
  return undefined
}

/** Answers a permission request of one of the caller's children. `answered` is false when nothing was waiting. */
export async function answer(ports: AnswerPorts, waiting: Waiting, parentID: string, input: AnswerInput) {
  const reply = input.reply as Reply
  if (!REPLIES.includes(reply)) throw new Error(`reply must be once, always or reject, not "${input.reply}".`)
  const entries = await entriesOf(ports.storage, input.sessionID)
  if (!entries.some((entry) => entry.parentID === parentID))
    throw new Error(`${input.sessionID} was not started by ${parentID} with courier_spawn; a session answers its own children's requests.`)
  const { sessionID, requestID } = input
  // Off the waiting list first, so the reply event this answer causes does not come back as a notice.
  waiting.delete(requestID)
  const holder = await holderOf(ports, sessionID, requestID)
  if (!holder) return { sessionID, requestID, reply, answered: false }
  const message = reply === "reject" ? input.message || REJECTED : undefined
  try {
    await holder.reply({ sessionID, requestID, reply, ...(message ? { message } : {}) })
  } catch (error) {
    if (!(await holderOf(ports, sessionID, requestID))) return { sessionID, requestID, reply, answered: false }
    waiting.add(requestID)
    throw error
  }
  return { sessionID, requestID, reply, answered: true }
}

/** The requests a session waits on, in whichever location holds them, for courier_status. */
export async function pendingOf(permissions: Iterable<Permissions>, sessionID: string) {
  const found = new Map<string, Pending>()
  for (const domain of permissions)
    for (const request of await domain.list({ sessionID }).catch(() => []))
      found.set(request.id, {
        type: "permission",
        requestID: request.id,
        action: request.action,
        resources: [...request.resources],
        ...(request.save?.length ? { save: [...request.save] } : {}),
      })
  return [...found.values()]
}
