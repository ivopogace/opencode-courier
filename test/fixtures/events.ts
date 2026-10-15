import type { FormCreated } from "../../src/person/form.js"
import type { FormField } from "../../src/person/ports.js"
import type { PermissionAsked, PermissionReplied } from "../../src/person/permission.js"
import type { WatchPorts } from "../../src/tree/ports.js"

/** The fakes the event-module tests share: a permission request, its events, the shared state and ports over a map. */

export const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"], save: ["git push*"] }

export const asked = (id = "evt_a", data: PermissionAsked["data"] = request): PermissionAsked & { type: string } => ({
  id,
  type: "permission.asked",
  data,
})

export const replied = (id = "evt_r", reply: PermissionReplied["data"]["reply"] = "once"): PermissionReplied & { type: string } => ({
  id,
  type: "permission.replied",
  data: { sessionID: "ses_child", requestID: "per_1", reply },
})

export const fresh = () => ({ seen: new Set<string>(), waiting: new Set<string>(), answered: new Set<string>(), forms: { told: new Map<string, Promise<unknown>>(), settled: new Set<string>() }, shown: new Map<string, { sessionID: string; title: string }>(), inbox: new Map<string, string>() })

export function fakePorts(streams: unknown[][] = [], pending: PermissionAsked["data"][] = [], store = new Map<string, unknown>()) {
  const sent: any[] = []
  const logged: string[] = []
  const scanned: string[] = []
  const nudges: number[] = []
  let subscriptions = 0
  const ports = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => {
        scanned.push(prefix)
        return { entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
      },
    },
    session: {
      synthetic: async (input: unknown) => {
        sent.push(input)
        return { id: "msg_1" }
      },
      context: async () => [
        { type: "user", text: "Fix the bug" },
        { type: "assistant", content: [{ type: "text", text: "Looked at it; " }, { type: "text", text: "line 4 is wrong." }] },
      ],
    },
    event: {
      subscribe: async function* () {
        const events = streams[subscriptions++]
        if (!events) throw new Error("stream closed")
        yield* events
      },
    },
    permissions: () => [
      { list: async ({ sessionID }: { sessionID: string }) => pending.filter((item) => item.sessionID === sessionID) },
    ],
    now: () => 1_000_000,
    log: (message: string) => void logged.push(message),
    nudge: () => void nudges.push(sent.length),
  } as unknown as WatchPorts
  return { ports, sent, logged, store, scanned, nudges, subscriptions: () => subscriptions }
}

export const child = (parentID = "ses_parent") => ({
  sessionID: "ses_child",
  parentID,
  title: "Fix the bug",
  directory: "/repo",
  isolated: false,
  createdAt: 1,
  reports: "status" as const,
})

export const choice: FormField = {
  key: "choice",
  description: "Allow OpenCode to search the web for up-to-date information?",
  type: "string",
  options: [
    { value: "allow", label: "Allow search via Courier Search" },
    { value: "choose", label: "Choose another provider" },
    { value: "disable", label: "Disable web search" },
  ],
}

export const webForm = { id: "frm_1", sessionID: "ses_child", title: "Web Search", metadata: { kind: "websearch.provider" }, fields: [choice] }

export const shown = (id = "evt_f", form: FormCreated["data"]["form"] = webForm): FormCreated & { type: string } => ({
  id,
  type: "form.created",
  data: { form },
})

export const settled = (id = "evt_s", type = "form.replied", formID = "frm_1") => ({ id, type, data: { id: formID, sessionID: "ses_child" } })
