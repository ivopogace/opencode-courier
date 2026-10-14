// The asks inbox, the person module's TUI part, against a fake TUI context whose dialogs a test answers.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { addAsksInbox, askFooter, askTitle, asksOf, INBOX_COMMAND, pathOf, SETTLE_MS, shown, soundOf, type Ask } from "../src/person/tui.js"
import type { Answered, Asks } from "../src/person/rpc.js"
import { REJECTED } from "../src/person/text.js"

const sessions: Asks["sessions"] = [
  { sessionID: "ses_a", title: "Fix the bug", parentID: "ses_root", depth: 1 },
  { sessionID: "ses_b", title: "Write tests", parentID: "ses_a", depth: 2, group: "pair" },
]
const bash = { sessionID: "ses_b", requestID: "per_1", action: "bash", resources: ["bun test"], save: ["bun *"] }
const greeting = {
  sessionID: "ses_a",
  requestID: "question_1",
  questions: [{ question: "Which greeting?", header: "Greeting", options: [{ label: "Hello", description: "Say hello" }, { label: "Hi", description: "" }] }],
}
const provider = {
  id: "frm_1",
  sessionID: "ses_a",
  title: "Choose a web search provider",
  metadata: { kind: "websearch.provider" },
  fields: [{ key: "provider", type: "string", title: "Provider", required: true, options: [{ value: "courier-search", label: "Courier search" }] }],
}
const questionForm = { id: "frm_q", sessionID: "ses_a", title: "Greeting", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string" }] }

type Dialog = { kind: "select" | "prompt" | "alert"; options: any }

/**
 * A fake TUI context with the open session `ses_root`: the person's RPC answers `state.asks`, the forms are
 * `state.forms`, and each dialog is answered by the next of `answers`, which backs out once they run out.
 */
function fakeContext(asks: Asks, forms: Record<string, unknown[]> = {}) {
  const state = { asks, forms, answered: { answered: true, by: "result" } as Answered }
  const dialogs: Dialog[] = []
  const answers: ((dialog: Dialog) => unknown)[] = []
  const calls: { method: string; input: unknown; options?: unknown }[] = []
  const toasts: { message: string; variant?: string }[] = []
  const notified: any[] = []
  const listeners = new Set<(event: { details: { type: string } }) => void>()
  const layers: (() => any)[] = []
  const sizes: unknown[] = []
  let route: { type: string; sessionID?: string } = { type: "session", sessionID: "ses_root" }
  const dialog = (kind: Dialog["kind"]) => async (options: any) => {
    const shown = { kind, options }
    dialogs.push(shown)
    return answers.shift()?.(shown)
  }
  const context = {
    location: { directory: "/workspace" },
    data: {
      location: { default: () => ({ directory: "/default" }) },
      session: {
        get: (sessionID: string) => (sessionID === "ses_root" ? { id: sessionID, title: "Root", location: { directory: "/project" } } : undefined),
        form: { reply: async (input: unknown) => void calls.push({ method: "form.reply", input }) },
      },
      listen: (handler: (event: { details: { type: string } }) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
    client: {
      rpc: (definition: { id: string }) => {
        expect(definition.id).toBe("courier-person")
        return {
          asks: async (input: unknown, options: unknown) => {
            calls.push({ method: "asks", input, options })
            return state.asks
          },
          answer: async (input: unknown, options: unknown) => {
            calls.push({ method: "answer", input, options })
            return state.answered
          },
        }
      },
      session: { form: { list: async ({ sessionID }: { sessionID: string }) => state.forms[sessionID] ?? [] } },
      permission: {
        reply: async (input: unknown) => void calls.push({ method: "permission.reply", input }),
        assert: async (input: unknown) => void calls.push({ method: "permission.assert", input }),
      },
    },
    ui: {
      router: { current: () => route },
      dialog: { select: dialog("select"), prompt: dialog("prompt"), alert: dialog("alert"), set: (options: unknown) => void sizes.push(options) },
      toast: { show: (toast: { message: string; variant?: string }) => void toasts.push(toast) },
    },
    attention: { notify: async (options: unknown) => (notified.push(options), { ok: true }) },
    keymap: { layer: (factory: () => any) => void layers.push(factory) },
  } as unknown as Plugin.Context
  const emit = (type: string) => {
    for (const listener of listeners) listener({ details: { type } })
  }
  return {
    context,
    state,
    dialogs,
    answers,
    calls,
    toasts,
    notified,
    listeners,
    layers,
    sizes,
    emit,
    goHome: () => void (route = { type: "home" }),
    replies: () => calls.filter(({ method }) => method !== "asks"),
  }
}

const empty: Asks = { top: "ses_root", sessions, permissions: [], questions: [] }
/** The dialog's option whose title starts with `title`, chosen. */
const pick = (title: string) => (dialog: Dialog) => dialog.options.options.find((option: any) => option.title.startsWith(title))?.value
const type = (text: string) => () => text
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50))

describe("what the inbox lists", () => {
  const listed = asksOf({ ...empty, permissions: [bash], questions: [greeting] }, new Map([["ses_a", [provider, questionForm] as any]]))

  test("each session's permission requests, questions and forms, in the tree's order, but question forms, which are its questions", () => {
    expect(listed.map((ask) => ask.key)).toEqual(["question question_1", "form frm_1", "permission per_1"])
  })

  test("says what each ask is, where it comes from, its depth and group", () => {
    expect(listed.map(askTitle)).toEqual(["Question: Greeting: Which greeting?", "Form: Choose a web search provider", "Permission: bash bun test"])
    expect(pathOf(empty, "ses_b", "Root")).toBe("Root › Fix the bug › Write tests")
    expect(listed.map(askFooter)).toEqual(["depth 1", "depth 1", "depth 2 · group pair"])
    expect(askFooter({ ...listed[0]!, question: { ...greeting, stopped: true } } as Ask)).toBe("depth 1 · cut off, answered by message")
    expect(listed.map(soundOf)).toEqual(["question", "question", "permission"])
  })

  test("a form field is asked unless hidden or its conditions on earlier answers fail", () => {
    const field = { key: "b", type: "boolean" } as const
    expect(shown(field, {})).toBe(true)
    expect(shown({ ...field, hidden: true }, {})).toBe(false)
    expect(shown({ ...field, when: [{ key: "a", op: "eq", value: "yes" }] }, { a: "yes" })).toBe(true)
    expect(shown({ ...field, when: [{ key: "a", op: "eq", value: "yes" }] }, { a: "no" })).toBe(false)
    expect(shown({ ...field, when: [{ key: "a", op: "neq", value: "yes" }] }, {})).toBe(true)
  })
})

describe("the inbox", () => {
  test("lists the open session's tree, read at its location, oldest first, with where each comes from", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context)
    await inbox.open()
    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    await inbox.open()

    expect(fake.calls[0]).toEqual({ method: "asks", input: { sessionID: "ses_root" }, options: { location: { directory: "/project" } } })
    expect(fake.sizes).toEqual([{ size: "large" }, { size: "large" }])
    const last = fake.dialogs.at(-1)!.options
    expect(last.title).toBe("Waiting on you (2)")
    // The permission request was seen first, so it stays first, though the question's session comes first in the tree.
    expect(last.options.map((option: any) => [option.title, option.description, option.footer])).toEqual([
      ["Permission: bash bun test", "Root › Fix the bug › Write tests", "depth 2 · group pair"],
      ["Question: Greeting: Which greeting?", "Root › Fix the bug", "depth 1"],
    ])
  })

  test("says so when nothing waits, or no session is open, and asks nothing then", async () => {
    const fake = fakeContext(empty)
    const inbox = addAsksInbox(fake.context)
    await inbox.open()
    fake.goHome()
    await inbox.open()

    expect(fake.toasts.map((toast) => toast.message)).toEqual([
      "Nothing in this courier tree waits on you.",
      "Open a session to see what its sessions ask you.",
    ])
    expect(fake.dialogs).toEqual([])
  })

  test("says so when the server cannot be read", async () => {
    const fake = fakeContext(empty)
    fake.state.asks = undefined as unknown as Asks
    ;(fake.context.client.rpc as any) = () => ({ asks: async () => Promise.reject({ type: "rpc.method_not_found", message: "Unknown RPC method courier-person.asks" }) })
    await addAsksInbox(fake.context).open()

    expect(fake.toasts).toEqual([expect.objectContaining({ message: "The asks could not be read: Unknown RPC method courier-person.asks", variant: "error" })])
  })

  test("is opened by its command: a key, /asks and the palette", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    addAsksInbox(fake.context)
    const layer = fake.layers[0]!()
    const [command] = layer.commands

    expect(layer.mode).toBe("global")
    expect(command).toMatchObject({ id: INBOX_COMMAND, bind: "<leader>k", palette: true, slash: { name: "asks", aliases: ["ask"] } })
    command.run()
    await settle()
    expect(fake.dialogs[0]!.options.title).toBe("Waiting on you (1)")
  })
})

describe("answering a permission request", () => {
  const answer = async (...steps: ((dialog: Dialog) => unknown)[]) => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    fake.answers.push(pick("Permission"), ...steps)
    await addAsksInbox(fake.context).open()
    return fake
  }

  test("allows it once or always through OpenCode's reply, as the person, never through assert, then lists what is left", async () => {
    for (const [choice, decision] of [["Allow once", "once"], ["Always allow", "always"]] as const) {
      const fake = await answer(pick(choice))
      // The inbox answers as the person, so no prompt is asked anywhere: the reply alone, straight to OpenCode.
      expect(fake.replies()).toEqual([{ method: "permission.reply", input: { sessionID: "ses_b", requestID: "per_1", decision } }])
      // Listed again, without the one answered, and so nothing is left.
      expect(fake.dialogs.map((dialog) => dialog.kind)).toEqual(["select", "select"])
      expect(fake.calls.filter(({ method }) => method === "asks")).toHaveLength(2)
    }
  })

  test("offers always only when the request has something to save", async () => {
    const fake = fakeContext({ ...empty, permissions: [{ ...bash, save: undefined } as any] })
    fake.answers.push(pick("Permission"))
    await addAsksInbox(fake.context).open()

    expect(fake.dialogs[1]!.options.options.map((option: any) => option.title)).toEqual(["Allow once", "Reject", "Reject with a reason…"])
  })

  test("rejects with the courier's reason, or the person's, so the session carries on", async () => {
    const plain = await answer(pick("Reject"))
    expect(plain.replies()).toEqual([{ method: "permission.reply", input: { sessionID: "ses_b", requestID: "per_1", decision: "reject", message: REJECTED } }])

    const reason = await answer(pick("Reject with"), type("Not on main"))
    expect(reason.replies()).toEqual([{ method: "permission.reply", input: { sessionID: "ses_b", requestID: "per_1", decision: "reject", message: "Not on main" } }])
  })

  test("backing out answers nothing and goes back to the list", async () => {
    const fake = await answer(() => undefined)
    expect(fake.replies()).toEqual([])
    expect(fake.dialogs.map((dialog) => dialog.options.title)).toEqual(["Waiting on you (1)", "Permission: bash bun test", "Waiting on you (1)"])
  })
})

describe("answering a question", () => {
  const toppings = {
    ...greeting,
    requestID: "question_2",
    questions: [{ question: "Which toppings?", header: "Toppings", options: [{ label: "Ham", description: "" }, { label: "Egg", description: "" }], multiple: true }],
  }

  test("passes the person's choice on through the person's RPC, at the session's location", async () => {
    const fake = fakeContext({ ...empty, questions: [greeting] })
    fake.answers.push(pick("Question"), pick("Hi"))
    await addAsksInbox(fake.context).open()

    expect(fake.dialogs[1]!.options.title).toBe("Greeting: Which greeting?")
    expect(fake.replies()).toEqual([
      { method: "answer", input: { sessionID: "ses_a", requestID: "question_1", answers: [["Hi"]] }, options: { location: { directory: "/workspace" } } },
    ])
  })

  test("takes an answer of the person's own, and several choices where the question allows them", async () => {
    const own = fakeContext({ ...empty, questions: [greeting] })
    own.answers.push(pick("Question"), pick("Type your own"), type("Good morning"))
    await addAsksInbox(own.context).open()
    expect((own.replies()[0]!.input as any).answers).toEqual([["Good morning"]])

    const several = fakeContext({ ...empty, questions: [toppings] })
    several.answers.push(pick("Question"), pick("[ ] Ham"), pick("[ ] Egg"), pick("[x] Ham"), pick("[ ] Ham"), pick("Done"))
    await addAsksInbox(several.context).open()
    expect((several.replies()[0]!.input as any).answers).toEqual([["Egg", "Ham"]])
  })

  test("says when the question no longer waits, or the answer was refused", async () => {
    const gone = fakeContext({ ...empty, questions: [greeting] })
    gone.state.answered = { answered: false }
    gone.answers.push(pick("Question"), pick("Hi"))
    await addAsksInbox(gone.context).open()
    expect(gone.toasts.map((toast) => toast.variant)).toEqual(["warning"])

    const refused = fakeContext({ ...empty, questions: [greeting] })
    refused.state.answered = { answered: false, problem: "answers needs one entry per question, 1 in all, not 2." }
    refused.answers.push(pick("Question"), pick("Hi"))
    await addAsksInbox(refused.context).open()
    expect(refused.toasts).toEqual([
      expect.objectContaining({ message: "The answer was not passed on: answers needs one entry per question, 1 in all, not 2.", variant: "error" }),
    ])
    // Not taken for answered: it is listed again.
    expect(refused.dialogs.at(-1)!.options.title).toBe("Waiting on you (1)")
  })
})

describe("answering a form", () => {
  test("asks each field it shows and replies through OpenCode's form reply", async () => {
    const form = {
      id: "frm_2",
      sessionID: "ses_b",
      title: "Deploy",
      fields: [
        { key: "target", type: "string", title: "Target", options: [{ value: "prod", label: "Production" }, { value: "dev", label: "Development" }] },
        { key: "confirm", type: "boolean", title: "Sure?", when: [{ key: "target", op: "eq", value: "prod" }] },
        { key: "why", type: "string", title: "Why?", when: [{ key: "target", op: "eq", value: "dev" }] },
        { key: "secret", type: "string", hidden: true },
        { key: "replicas", type: "integer", title: "Replicas" },
        { key: "regions", type: "multiselect", title: "Regions", options: [{ value: "eu", label: "Europe" }, { value: "us", label: "America" }] },
      ],
    }
    const fake = fakeContext(empty, { ses_b: [form] })
    fake.answers.push(pick("Form"), pick("Production"), pick("Yes"), type("two"), type("2"), pick("[ ] Europe"), pick("Done"))
    await addAsksInbox(fake.context).open()

    expect(fake.replies()).toEqual([
      { method: "form.reply", input: { sessionID: "ses_b", formID: "frm_2", answer: { target: "prod", confirm: true, replicas: 2, regions: ["eu"] } } },
    ])
    expect(fake.toasts.map((toast) => toast.message)).toEqual(["Replicas takes a whole number"])
  })

  test("a form that opens a page is left to its own session", async () => {
    const fake = fakeContext(empty, { ses_a: [{ id: "frm_3", sessionID: "ses_a", title: "Sign in", fields: [{ key: "login", type: "external", url: "https://example.com" }] }] })
    fake.answers.push(pick("Form"), () => undefined)
    await addAsksInbox(fake.context).open()

    expect(fake.dialogs[1]).toEqual({ kind: "alert", options: { title: "Sign in · login", message: "This form opens https://example.com: answer it in its own session." } })
    expect(fake.replies()).toEqual([])
  })
})

describe("attention", () => {
  test("a new ask in the open session's tree sounds once, a permission request's or a question's sound", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    addAsksInbox(fake.context)

    fake.emit("permission.asked")
    fake.emit("permission.asked")
    await settle()
    expect(fake.notified).toEqual([
      { title: "Root › Fix the bug › Write tests", message: "Permission: bash bun test", notification: { when: "blurred" }, sound: { name: "permission", when: "always" } },
    ])

    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    fake.emit("session.text.delta")
    await settle()
    expect(fake.notified).toHaveLength(1)
    fake.emit("form.created")
    await settle()
    expect(fake.notified.map((options) => options.sound.name)).toEqual(["permission", "question"])
  })

  test("nothing sounds on the home screen, and its cleanup stops listening", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    fake.goHome()
    const inbox = addAsksInbox(fake.context)
    fake.emit("permission.asked")
    await settle()
    expect(fake.notified).toEqual([])

    inbox.cleanup()
    expect(fake.listeners.size).toBe(0)
  })

  test("names where an ask comes from by the sessions' current titles, the RPC's as the fallback", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const get = fake.context.data.session.get
    fake.context.data.session.get = (id: string) => (id === "ses_a" ? ({ id, title: "Renamed", location: { directory: "/workspace" } } as any) : get(id))
    const inbox = addAsksInbox(fake.context)
    await inbox.open()
    expect((fake.dialogs[0]!.options as any).options[0].description).toBe("Root › Renamed › Write tests")

    fake.emit("permission.asked")
    await settle()
    expect(fake.notified[0].title).toBe("Root › Renamed › Write tests")
  })

  test("pathOf falls back to the RPC's title for a session the TUI does not know or that has none yet", () => {
    expect(pathOf(empty, "ses_b", "Root", (id) => (id === "ses_a" ? "" : undefined))).toBe("Root › Fix the bug › Write tests")
    expect(pathOf(empty, "ses_b", "Root", (id) => (id === "ses_b" ? "Tests, renamed" : undefined))).toBe("Root › Fix the bug › Tests, renamed")
  })

  test("an RPC failure, thrown as OpenCode's client throws it, says why", async () => {
    const ans = fakeContext({ ...empty, questions: [greeting] })
    const rpc = ans.context.client.rpc as any
    ;(ans.context.client.rpc as any) = (d: any) => ({ ...rpc(d), answer: async () => Promise.reject({ type: "rpc.unavailable", message: "closing" }) })
    ans.answers.push(pick("Question"), pick("Hi"))
    await addAsksInbox(ans.context).open()

    expect(ans.toasts[0]!.message).toBe("The answer was not passed on: closing")
  })
})

describe("a choice field's dialog says what it asks", () => {
  const ask = async (field: Record<string, unknown>, answer: (dialog: Dialog) => unknown) => {
    const form = { id: "frm_s", sessionID: "ses_a", title: "Web Search", fields: [{ key: "choice", description: "Allow OpenCode to search the web?", ...field }] }
    const fake = fakeContext(empty, { ses_a: [form] })
    fake.answers.push(pick("Form"), answer)
    await addAsksInbox(fake.context).open()
    return fake.dialogs[1]!
  }
  const options = [{ value: "allow", label: "Allow" }, { value: "disable", label: "Disable" }]

  test.each([
    ["a boolean", { type: "boolean" }],
    ["a multiselect", { type: "multiselect", options }],
    ["a string with options", { type: "string", required: true, options }],
  ])("%s shows the description first, and the form and field in its title", async (_name, field) => {
    const dialog = await ask(field, () => undefined)
    expect(dialog.options.title).toBe("Web Search · choice")
    expect(dialog.options.options[0]).toMatchObject({ title: "Allow OpenCode to search the web?", disabled: true })
  })

  test("a field's own title replaces its key, and without a description there is no extra option", async () => {
    const dialog = await ask({ type: "boolean", title: "Search", description: undefined }, () => undefined)
    expect(dialog.options.title).toBe("Web Search · Search")
    expect(dialog.options.options.map((option: any) => option.title)).toEqual(["Yes", "No"])
  })
})

test("the description row of a boolean's dialog shares no value with Yes or No", async () => {
  const form = { id: "frm_s", sessionID: "ses_a", title: "Web Search", fields: [{ key: "ok", type: "boolean", description: "Allow?" }] }
  const fake = fakeContext(empty, { ses_a: [form] })
  fake.answers.push(pick("Form"), pick("Yes"))
  await addAsksInbox(fake.context).open()
  const values = fake.dialogs[1]!.options.options.map((option: any) => option.value)
  expect(new Set(values).size).toBe(3)
  expect(fake.calls.find((call) => call.method === "form.reply")).toMatchObject({ method: "form.reply", input: { answer: { ok: true } } })
})
