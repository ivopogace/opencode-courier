import type { Plugin } from "@opencode/plugin"
import { lineage, subtree } from "../tree/index.js"
import { ownRequests, pendingOf, type Permissions } from "./permission.js"
import { answerForPerson, pendingQuestions, type QuestionPorts } from "./question/index.js"
import { personRpc, type Answered, type Asks } from "./rpc.js"

/** What the person's RPC reads and answers through: the relay's ports, which carry the storage, and every location's permissions. */
export interface PersonRpcPorts {
  readonly questions: QuestionPorts
  readonly permissions: () => Iterable<Permissions>
}

/**
 * The permission requests and questions waiting in the courier tree a session is in, the top's own requests first, read from the
 * roster from the top of its lineage down, so each session of the tree sees the same inbox.
 */
export async function asks(ports: PersonRpcPorts, sessionID: string): Promise<Asks> {
  const { storage } = ports.questions
  const top = (await lineage(storage, sessionID)).at(-1)?.parentID ?? sessionID
  const { nodes } = await subtree(storage, top, { now: ports.questions.now() })
  const own = nodes.length ? await ownRequests(ports.permissions(), top).catch(() => []) : []
  const waiting = await Promise.all(
    nodes.map(({ entry }) =>
      Promise.all([
        pendingOf(ports.permissions(), entry.sessionID).catch(() => []),
        pendingQuestions(storage, entry.sessionID).catch(() => []),
      ]),
    ),
  )
  return {
    top,
    sessions: nodes.map(({ entry, depth }) => ({
      sessionID: entry.sessionID,
      title: entry.title,
      parentID: entry.parentID,
      depth,
      ...(entry.group ? { group: entry.group } : {}),
    })),
    permissions: [
      ...own.map(({ request, passesOn }) => ({
        sessionID: top,
        requestID: request.id,
        action: request.action,
        resources: [...request.resources],
        ...(request.save?.length ? { save: [...request.save] } : {}),
        ...(passesOn ? { passesOn } : {}),
      })),
      ...nodes.flatMap(({ entry }, index) =>
        waiting[index]![0].flatMap((pending) =>
          pending.type === "permission"
            ? [
                {
                  sessionID: entry.sessionID,
                  requestID: pending.requestID,
                  action: pending.action,
                  resources: pending.resources,
                  ...(pending.save ? { save: pending.save } : {}),
                },
              ]
            : [],
        ),
      ),
    ],
    questions: nodes.flatMap(({ entry }, index) =>
      waiting[index]![1].map(({ requestID, questions, stopped }) => ({
        sessionID: entry.sessionID,
        requestID,
        questions,
        ...(stopped ? { stopped } : {}),
      })),
    ),
  }
}

/** Passes the person's answers to a question on, as courier_answer does; a refusal, such as answers that do not fit, comes back as `problem`. */
export async function answer(ports: PersonRpcPorts, input: { sessionID: string; requestID: string; answers: ReadonlyArray<ReadonlyArray<string>> }): Promise<Answered> {
  try {
    const result = await answerForPerson(ports.questions, input)
    return result.answered ? { answered: true, by: result.by } : { answered: false }
  } catch (error) {
    return { answered: false, problem: error instanceof Error ? error.message : String(error) }
  }
}

/** Serves the person's RPC at the plugin's location; disposed with the plugin. */
export function registerPersonRpc(rpc: Pick<Plugin.Context["rpc"], "register">, ports: PersonRpcPorts) {
  return rpc.register(personRpc, {
    asks: ({ sessionID }) => asks(ports, sessionID),
    answer: (input) => answer(ports, input),
  })
}
