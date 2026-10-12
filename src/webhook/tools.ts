import { Schema } from "effect"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { subscribe, unsubscribe, type WebhookPorts } from "./subscriptions.js"
import { subscribeText, unsubscribeText } from "./text.js"

export const SubscribeInput = Schema.Struct({
  topic: Schema.String.annotate({
    description:
      "owner/repo for every event of a GitHub repository, owner/repo#<number> for one pull request or issue " +
      "(reviews, comments, completed CI runs), or a plain name for deliveries posted to /hook/<name>.",
  }),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to subscribe; defaults to this one." })),
})

export const UnsubscribeInput = Schema.Struct({
  topic: Schema.optional(Schema.String.annotate({ description: "The topic to drop; all of this session's when omitted." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to unsubscribe; defaults to this one." })),
})

/** What the webhook tools run on. */
export interface WebhookToolPorts {
  readonly hooks: WebhookPorts
  /** Whether a webhook receiver runs in this server. */
  readonly receiving: () => Promise<boolean>
}

/** Adds `courier_subscribe` and `courier_unsubscribe`. */
export function addWebhookTools(tools: ToolEditor, ports: WebhookToolPorts) {
  tools.add({
    name: "courier_subscribe",
    options: { codemode: false },
    description:
      "Wake a session (this one by default) when a webhook arrives for a topic: a GitHub repository, one of its " +
      "pull requests or issues (reviews, comments, completed CI runs), or a named generic hook. Each matching " +
      "delivery arrives as a message, queued behind any running turn. End your turn and wait; do not poll.",
    input: SubscribeInput,
    execute: async (input, context) => {
      const sessionID = input.sessionID ?? context.sessionID
      const subscription = await subscribe(ports.hooks, sessionID, input.topic).catch(rethrow("courier_subscribe"))
      const receiving = await ports.receiving()
      return {
        content: subscribeText(sessionID, subscription.topic, receiving),
        metadata: { sessionID, topic: subscription.topic, receiver: receiving },
      }
    },
  })

  tools.add({
    name: "courier_unsubscribe",
    options: { codemode: false },
    description: "Stop webhook deliveries for a topic, or all of a session's topics, e.g. once its pull request is merged.",
    input: UnsubscribeInput,
    execute: async (input, context) => {
      const sessionID = input.sessionID ?? context.sessionID
      const dropped = await unsubscribe(ports.hooks, sessionID, input.topic).catch(rethrow("courier_unsubscribe"))
      return { content: unsubscribeText(sessionID, dropped), metadata: { sessionID, dropped } }
    },
  })
}
