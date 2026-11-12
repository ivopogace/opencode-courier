export const GO_COUNT = ".go-count"
export const GO_HALVES = ".go-halves"
export const CONFLICT_FILE = "numbers/b.txt"

export const toolsOf = (list) => list.flatMap((message) => (message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []))
export const textOf = (message) =>
  message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : (message.text ?? "")
export const contentText = (state) => (state.content ?? []).flatMap((item) => (typeof item?.text === "string" ? [item.text] : [])).join("")
export const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
export const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
export const taskOf = (list) => textOf(list.find((message) => message.type === "user" || message.type === "synthetic") ?? {})
const FORBIDS = /\b(?:not|never|don't|except|other than|besides)\b/i
const ELSEWHERE = /\b(?:other|another) (?:part|half|session)\b|\bnothing\b/i
const sentencesOf = (list) => taskOf(list).split(/(?<=[.!?])\s+|\n/)
export const isCount = (list) =>
  sentencesOf(list).some((sentence) => /99 - 57/.test(sentence) || (sentence.includes("count/total.txt") && !FORBIDS.test(sentence) && !ELSEWHERE.test(sentence)))
export const isHalfB = (list) =>
  sentencesOf(list).some((sentence) => /2 \*\* 10/.test(sentence) || (sentence.includes(CONFLICT_FILE) && !FORBIDS.test(sentence)))
export const hasRun = (list) => list.some((message) => message.type === "assistant")
export function childOf(part) {
  if (part.name !== "courier_spawn" || part.state.status !== "completed") return undefined
  const metadata = part.state.metadata ?? {}
  return metadata.sessionID ?? metadata.metadata?.sessionID ?? contentText(part.state).match(/Started session (ses_\w+)/)?.[1]
}
export const spawnsOf = (list) => toolsOf(list).map(childOf).filter(Boolean)
export const sendersOf = (message) => (message.type === "synthetic" ? (message.text.match(/^<courier from="([^"]+)"/)?.[1].split(",") ?? []) : [])
export const groupOf = (message) => message.text?.match(/^<courier from="[^"]*" group="([^"]+)"/)?.[1]
export const statusOf = (message, from) =>
  groupOf(message)
    ? message.text.match(new RegExp(`^\\[\\d+/\\d+\\] ${from} ".*": (\\w+)$`, "m"))?.[1]
    : message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]
export const sendsTo = (list, to) =>
  list.flatMap((message, index) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part, place) =>
          part.type === "tool" && part.name === "courier_send" && part.state.status === "completed" && part.state.input?.sessionID === to
            ? [{ index, place, status: part.state.input.status, message: part.state.input.message }]
            : [],
        ),
  )
export const reportsTo = (list, parentID) => sendsTo(list, parentID).filter((send) => send.status)
export const delivered = (list, from, after = -1) => list.findIndex((message, index) => index > after && sendersOf(message).includes(from) && !groupOf(message) && !statusOf(message, from))
export const plainAfter = (list, to, after) => sendsTo(list, to).find((send) => send.index > after && !send.status)
const carriedInSpawn = (list, child, after) =>
  list.some(
    (message, index) =>
      index > after && message.type === "assistant" && message.content.some((part) => childOf(part) === child && /\bchecked\b/i.test(part.state.input?.task ?? "")),
  )
export const toldAfter = (list, child, after) => plainAfter(list, child, after) ?? (carriedInSpawn(list, child, after) ? { spawned: true } : undefined)
export const typedAt = (list, sessionID) =>
  list.findIndex((message) => message.type === "synthetic" && message.text?.startsWith(`<courier from="courier" route="prompt" in="${sessionID}">`))
export function toldOf(tree, depth) {
  for (const [, entry] of tree)
    for (const message of entry.list) {
      const id = message.type === "synthetic" ? message.text.match(/^<courier from="courier" route="prompt" in="([^"]+)">/)?.[1] : undefined
      if (id !== undefined && tree.get(id)?.depth === depth) return id
    }
  return undefined
}
export const toldHalfOf = (tree) => toldOf(tree, 2)
export const countIdOf = (tree) => toldOf(tree, 1) ?? [...tree].find(([, entry]) => entry.depth === 1 && isCount(entry.list))?.[0]
export const passedDown = (entry, rootID) => {
  const reached = delivered(entry.list, rootID)
  const below = spawnsOf(entry.list)
  return reached !== -1 && below.length > 0 && below.every((child) => toldAfter(entry.list, child, reached))
}

const open = (part) => part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error"
const names = (part, file) => part.name === "shell" && JSON.stringify(part.state.input ?? {}).includes(file)
export function waitOf(list, files) {
  const at = list.findLastIndex((message) => message.type === "assistant")
  const last = list[at]
  if (!last || ended(last) || last.time?.completed !== undefined || list.slice(at + 1).some((message) => message.type === "idle")) return undefined
  const calls = last.content.filter(open)
  return calls.length ? files.find((file) => calls.every((part) => names(part, file))) : undefined
}

function stoppedAt(tree, rootID, { finding, conflict, told }, file) {
  const depth1 = [...tree].filter(([, entry]) => entry.depth === 1)
  const countID = countIdOf(tree)
  if (file === GO_COUNT) return finding ? 'no "count" session at depth 1 is in a turn to take the person\'s message' : 'no session at depth 1 has run the "count" part'
  if (conflict) return `no half for ${CONFLICT_FILE} at depth 2 is in a turn to take the person's message`
  if (!finding) return "no session is left to pass anything on"
  if (!told) return 'the person\'s message was never written, for want of a "count" session at depth 1 in a turn to take it'
  const root = tree.get(rootID).list
  const envelopeAt = countID === undefined ? -1 : typedAt(root, countID)
  if (envelopeAt === -1) return "the finding has not reached the root"
  const others = depth1.filter(([id]) => id !== countID)
  if (!others.length) return "the root has the finding and no other part to pass it on to"
  if (!others.every(([id]) => plainAfter(root, id, envelopeAt))) return "the root has the finding and has ended its turn without passing it on to each other part"
  if (others.every(([, entry]) => passedDown(entry, rootID))) return undefined
  if (!others.every(([, entry]) => !settled(entry.list) || delivered(entry.list, rootID) !== -1)) return undefined
  if (others.some(([, entry]) => !settled(entry.list))) return "the root passed the finding on to a session that sits in the wait itself"
  return "the other part's session has the finding and has ended its turn without passing it on to each of its sessions"
}

export function releaseOf(tree, rootID, state) {
  const pending = [GO_COUNT, GO_HALVES].filter((file) => !state.created.includes(file))
  const sessions = [...tree.values()].map((entry) => ({ entry, wait: waitOf(entry.list, pending) }))
  if (!sessions.every(({ entry, wait }) => wait || settled(entry.list))) return undefined
  const file = pending.find((name) => sessions.some(({ wait }) => wait === name))
  if (!file) return undefined
  const where = stoppedAt(tree, rootID, state, file)
  return where ? { file, why: `${where}, and every session has ended its turn or sits in a wait on a file` } : undefined
}
