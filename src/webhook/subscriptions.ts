import type { Plugin } from "@opencode/plugin"
import { scanAll } from "../platform/storage.js"

type Context = Plugin.Context

const PREFIX = "webhook/"

export interface WebhookPorts {
  readonly storage: Pick<Context["storage"], "get" | "set" | "remove" | "scan">
  readonly session: Pick<Context["session"], "synthetic" | "get">
  readonly now: () => number
  readonly log: (message: string) => void
}

export interface Subscription {
  readonly sessionID: string
  readonly topic: string
  readonly createdAt: number
}

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/
export const GENERIC_NAME = /^[\w.-]{1,64}$/

export function parseTopic(input: string) {
  const raw = input.trim()
  const github = raw.replace(/^github:/i, "")
  const [repo, number, ...rest] = github.split("#")
  if (repo && GITHUB_REPO.test(repo) && rest.length === 0 && (number === undefined || /^\d+$/.test(number))) {
    const suffix = number === undefined ? "" : `#${Number(number)}`
    return `github:${repo.toLowerCase()}${suffix}`
  }
  if (GENERIC_NAME.test(raw)) return raw
  throw new Error(
    `Not a topic: ${JSON.stringify(input)}. Use owner/repo, owner/repo#<number>, or a name of letters, digits, ".", "_" and "-".`,
  )
}

const topicPrefix = (topic: string) => `${PREFIX}${encodeURIComponent(topic)}/`
export const keyOf = (sessionID: string, topic: string) => topicPrefix(topic) + sessionID

export async function subscribe(ports: WebhookPorts, sessionID: string, topic: string) {
  const subscription: Subscription = { sessionID, topic: parseTopic(topic), createdAt: ports.now() }
  await ports.session.get({ sessionID })
  await ports.storage.set(keyOf(sessionID, subscription.topic), { ...subscription })
  return subscription
}

export async function unsubscribe(ports: WebhookPorts, sessionID: string, topic?: string) {
  if (topic !== undefined) {
    const key = keyOf(sessionID, parseTopic(topic))
    if ((await ports.storage.get(key)) === undefined) return []
    await ports.storage.remove(key)
    return [parseTopic(topic)]
  }
  const dropped = (await subscriptions(ports)).filter((item) => item.sessionID === sessionID)
  await Promise.all(dropped.map((item) => ports.storage.remove(keyOf(item.sessionID, item.topic))))
  return dropped.map((item) => item.topic)
}

export function subscriptions(ports: Pick<WebhookPorts, "storage">, topic?: string) {
  return scanAll<Subscription>(ports.storage, topic === undefined ? PREFIX : topicPrefix(topic))
}

export async function subscribedSince(ports: Pick<WebhookPorts, "storage">, sessionID: string, since: number) {
  return (await subscriptions(ports)).some((subscription) => subscription.sessionID === sessionID && subscription.createdAt >= since)
}
