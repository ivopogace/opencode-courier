// The asks inbox, the person module's TUI part, against a fake TUI context whose dialogs a test answers.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { addAsksInbox, askFooter, askTitle, asksOf, INBOX_COMMAND, pathOf, SETTLE_MS, active, type Ask } from "../src/person/tui.js"
import type { Answered, Asks } from "../src/person/rpc.js"
import { REJECTED } from "../src/person/text.js"
import { CHANGES as FOLLOWS } from "../src/tree/tui.js"

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
  const state = { asks, forms, formError: undefined as unknown, answered: { answered: true, by: "result" } as Answered }
  const dialogs: Dialog[] = []
  const answers: ((dialog: Dialog) => unknown)[] = []
  const calls: { method: string; input: unknown; options?: unknown }[] = []
  const toasts: { message: string; variant?: string }[] = []
  const notified: any[] = []
  const native = new Set<string>()
  const listeners = new Set<(event: { details: { type: string } }) => void>()
  const layers: (() => any)[] = []
  const sizes: unknown[] = []
  let route: { type: string; sessionID?: string } = { type: "session", sessionID: "ses_root" }
  // As the host's: a dialog shown, or cleared, closes the one before, whose promise resolves with nothing.
  let close: (() => void) | undefined
  let cleared = 0
  const dialog = (kind: Dialog["kind"]) => (options: any) => {
    close?.()
    const shown = { kind, options }
    dialogs.push(shown)
    return new Promise((resolve) => {
      let open = true
      const settle = (value: unknown) => {
        if (!open) return
        open = false
        if (close === closing) close = undefined
        resolve(value)
      }
      const closing = () => settle(undefined)
      close = closing
      void Promise.resolve(answers.shift()?.(shown)).then(settle)
    })
  }
  const context = {
    location: { directory: "/workspace" },
    data: {
      location: { default: () => ({ directory: "/default" }) },
      session: {
        get: (sessionID: string) =>
          sessionID === "ses_root"
            ? { id: sessionID, title: "Root", location: { directory: "/project" } }
            : native.has(sessionID)
              ? { id: sessionID, parentID: "ses_root" }
              : undefined,
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
      session: {
        form: {
          list: async ({ sessionID }: { sessionID: string }) => state.forms[sessionID] ?? [],
          reply: async (input: unknown) => {
            calls.push({ method: "form.reply", input })
            if (state.formError) throw state.formError
          },
        },
      },
      permission: {
        reply: async (input: unknown) => void calls.push({ method: "permission.reply", input }),
        assert: async (input: unknown) => void calls.push({ method: "permission.assert", input }),
      },
    },
    ui: {
      router: { current: () => route },
      dialog: {
        select: dialog("select"),
        prompt: dialog("prompt"),
        alert: dialog("alert"),
        set: (options: unknown) => void sizes.push(options),
        clear: () => {
          cleared++
          close?.()
        },
      },
      toast: { show: (toast: { message: string; variant?: string }) => void toasts.push(toast) },
    },
    attention: { notify: async (options: unknown) => (notified.push(options), { ok: true }) },
    keymap: { layer: (factory: () => any) => void layers.push(factory) },
  } as unknown as Plugin.Context
  const emit = (type: string, sessionID?: string) => {
    // As the host sends them: a form's session is in its form.
    const data = type === "form.created" ? { form: { sessionID } } : { sessionID }
    for (const listener of listeners) listener({ details: { type, ...(sessionID ? { data } : {}) } } as never)
  }
  return {
    context,
    native,
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
    cleared: () => cleared,
    goHome: () => void (route = { type: "home" }),
    goSession: (sessionID: string) => void (route = { type: "session", sessionID }),
    replies: () => calls.filter(({ method }) => method !== "asks"),
  }
}

const empty: Asks = { top: "ses_root", sessions, permissions: [], questions: [] }
/** The dialog's option whose title starts with `title`, chosen. */
const pick = (title: string) => (dialog: Dialog) => dialog.options.options.find((option: any) => option.title.startsWith(title))?.value
const type = (text: string) => () => text
/** Leaves the dialog open until another replaces it. */
const hold = () => new Promise(() => undefined)
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
  })

  test("a form field applies unless its conditions on earlier answers fail", () => {
    const field = { key: "b", type: "boolean" } as const
    expect(active(field, {})).toBe(true)
    expect(active({ ...field, when: [{ key: "a", op: "eq", value: "yes" }] }, { a: "yes" })).toBe(true)
    expect(active({ ...field, when: [{ key: "a", op: "eq", value: "yes" }] }, { a: "no" })).toBe(false)
    expect(active({ ...field, when: [{ key: "a", op: "neq", value: "yes" }] }, {})).toBe(false)
    expect(active({ ...field, when: [{ key: "a", op: "eq", value: "yes" }] }, {})).toBe(false)
    expect(active({ ...field, when: [{ key: "a", op: "neq", value: "yes" }] }, { a: "no" })).toBe(true)
    expect(active({ ...field, when: [{ key: "a", op: "eq", value: "ts" }] }, { a: ["ts", "go"] })).toBe(true)
    expect(active({ ...field, when: [{ key: "a", op: "eq", value: "ts" }] }, { a: ["go"] })).toBe(false)
    expect(active({ ...field, when: [{ key: "a", op: "neq", value: "go" }] }, { a: ["ts", "go"] })).toBe(false)
    expect(active({ ...field, when: [{ key: "a", op: "neq", value: "go" }] }, { a: ["ts"] })).toBe(true)
  })
})

describe("the inbox", () => {
  test("lists the open session's tree, read at its location, oldest first, with where each comes from", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
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
    const inbox = addAsksInbox(fake.context, FOLLOWS)
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
    await addAsksInbox(fake.context, FOLLOWS).open()

    expect(fake.toasts).toEqual([expect.objectContaining({ message: "The asks could not be read: Unknown RPC method courier-person.asks", variant: "error" })])
  })

  test("is opened by its command: a key, /asks and the palette", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    addAsksInbox(fake.context, FOLLOWS)
    const layer = fake.layers[0]!()
    const [command] = layer.commands

    expect(layer.mode).toBe("global")
    expect(command).toMatchObject({ id: INBOX_COMMAND, bind: "<leader>k", palette: true, slash: { name: "asks", aliases: ["ask"] } })
    command.run()
    await settle()
    expect(fake.dialogs[0]!.options.title).toBe("Waiting on you (1)")
  })
})

describe("the open list follows the tree", () => {
  const titles = (dialog: Dialog) => dialog.options.options.map((option: any) => option.title)
  const asksRead = (fake: ReturnType<typeof fakeContext>) => fake.calls.filter(({ method }) => method === "asks").length

  test("an ask that arrives shows in it, one settled elsewhere leaves it, and it closes once none is left", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(hold)
    const opening = inbox.open()
    await settle()
    expect(fake.dialogs.map((dialog) => dialog.options.title)).toEqual(["Waiting on you (1)"])

    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    fake.answers.push(hold)
    fake.emit("session.execution.started", "ses_a")
    await settle()
    expect(fake.dialogs.at(-1)!.options.title).toBe("Waiting on you (2)")
    expect(titles(fake.dialogs.at(-1)!)).toEqual(["Permission: bash bun test", "Question: Greeting: Which greeting?"])
    expect(fake.sizes).toEqual([{ size: "large" }, { size: "large" }])

    fake.state.asks = { ...empty, questions: [greeting] }
    fake.answers.push(hold)
    fake.emit("permission.replied", "ses_b")
    await settle()
    expect(fake.dialogs.at(-1)!.options.title).toBe("Waiting on you (1)")
    expect(titles(fake.dialogs.at(-1)!)).toEqual(["Question: Greeting: Which greeting?"])

    fake.state.asks = empty
    fake.emit("session.execution.succeeded", "ses_a")
    await opening
    expect(fake.dialogs).toHaveLength(3)
    expect(fake.cleared()).toBe(1)
    expect(fake.toasts).toEqual([])
  })

  test("a form that arrives or is settled elsewhere does too", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(hold)
    const opening = inbox.open()
    await settle()

    fake.state.forms = { ses_a: [provider] }
    fake.answers.push(hold)
    fake.emit("form.created", "ses_a")
    await settle()
    expect(titles(fake.dialogs.at(-1)!)).toEqual(["Permission: bash bun test", "Form: Choose a web search provider"])

    fake.state.forms = {}
    fake.answers.push(() => undefined)
    fake.emit("form.cancelled", "ses_a")
    await opening
    expect(titles(fake.dialogs.at(-1)!)).toEqual(["Permission: bash bun test"])
  })

  test("the list chosen from after it changed answers as before", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(hold)
    const opening = inbox.open()
    await settle()

    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    fake.answers.push(pick("Permission"), pick("Allow once"))
    fake.emit("permission.asked", "ses_a")
    await opening
    expect(fake.replies()).toEqual([{ method: "permission.reply", input: { sessionID: "ses_b", requestID: "per_1", decision: "once" } }])
    // Listed again after the answer, with the question left; then the person leaves.
    expect(titles(fake.dialogs.at(-1)!)).toEqual(["Question: Greeting: Which greeting?"])
  })

  test("is not shown again when the asks are the same, nor read on an event the footer does not follow", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(hold)
    void inbox.open()
    await settle()
    const read = asksRead(fake)

    fake.emit("session.status", "ses_a")
    await settle()
    expect(asksRead(fake)).toBe(read + 1)
    fake.emit("session.text.delta", "ses_a")
    await settle()
    expect(asksRead(fake)).toBe(read + 1)
    expect(fake.dialogs).toHaveLength(1)
  })

  test("follows nothing while an ask is being answered, or once the list is closed", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(pick("Permission"), hold)
    const opening = inbox.open()
    await settle()
    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    fake.emit("session.execution.started", "ses_a")
    await settle()
    expect(fake.dialogs.at(-1)!.options.title).toBe("Permission: bash bun test")

    // Leaving the permission's dialog lists the tree again, read then; leaving the list closes it.
    fake.dialogs.length = 0
    fake.context.ui.dialog.clear()
    await opening
    expect(fake.dialogs.map((dialog) => dialog.options.title)).toEqual(["Waiting on you (2)"])
    const read = asksRead(fake)
    fake.emit("session.execution.succeeded", "ses_a")
    await settle()
    expect(asksRead(fake)).toBe(read)
  })
})

describe("answering a permission request", () => {
  const answer = async (...steps: ((dialog: Dialog) => unknown)[]) => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    fake.answers.push(pick("Permission"), ...steps)
    await addAsksInbox(fake.context, FOLLOWS).open()
    return fake
  }

  test("allows it once or always through OpenCode's reply, as the person, never through assert, then lists what is left", async () => {
    for (const [choice, decision] of [["Allow once", "once"], ["Always allow", "always"]] as const) {
      const fake = await answer(pick(choice))
      // The inbox answers as the person, so no prompt is asked anywhere: the reply alone, straight to OpenCode.
      expect(fake.replies()).toEqual([{ method: "permission.reply", input: { sessionID: "ses_b", requestID: "per_1", decision } }])
      // Listed again, without the one answered, and so nothing is left.
      expect(fake.dialogs.map((dialog) => dialog.kind)).toEqual(["select", "select"])
      // The start-up read, then the two the inbox makes.
      expect(fake.calls.filter(({ method }) => method === "asks")).toHaveLength(3)
    }
  })

  test("offers always only when the request has something to save", async () => {
    const fake = fakeContext({ ...empty, permissions: [{ ...bash, save: undefined } as any] })
    fake.answers.push(pick("Permission"))
    await addAsksInbox(fake.context, FOLLOWS).open()

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

describe("the top session's own permission requests", () => {
  // The top's courier_answer prompt for ses_b's request, and a request of the top's own.
  const prompt = { sessionID: "ses_root", requestID: "per_top", action: "bash", resources: ["bun test"], passesOn: { sessionID: "ses_b", requestID: "per_1" } }
  const own = { sessionID: "ses_root", requestID: "per_own", action: "edit", resources: ["src/a.ts"], save: ["src/*"] }
  const withTop: Asks = { ...empty, permissions: [prompt, own, bash] }

  test("are listed first, worded as the top's, the child's request as the one its prompt asks for", () => {
    const listed = asksOf(withTop, new Map())
    expect(listed.map((ask) => ask.key)).toEqual(["permission per_top", "permission per_own", "permission per_1"])
    expect(listed.map(askTitle)).toEqual(['Permission (top session): courier_answer once for "bash bun test"', "Permission (top session): edit src/a.ts", "Permission: bash bun test"])
    expect(listed.map(askFooter)).toEqual([
      "top session",
      "top session",
      "depth 2 · group pair · the top's prompt asks",
    ])
    expect(pathOf(withTop, "ses_root", "Root")).toBe("Root")
  })

  test("are listed before older asks of the sessions below, and answered through OpenCode's reply in the top session", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(hold)
    const opening = inbox.open()
    await settle()

    fake.state.asks = withTop
    fake.answers.push(pick("Permission (top session): courier"), pick("Allow once"))
    fake.emit("permission.asked", "ses_root")
    await settle()
    const list = fake.dialogs.findLast((dialog) => dialog.options.title === "Waiting on you (3)")!
    expect(list.options.options.map((option: any) => [option.title, option.description])).toEqual([
      ['Permission (top session): courier_answer once for "bash bun test"', "Root"],
      ["Permission (top session): edit src/a.ts", "Root"],
      ["Permission: bash bun test", "Root › Fix the bug › Write tests"],
    ])
    fake.state.asks = { ...empty, permissions: [own] }
    await opening
    expect(fake.replies()).toEqual([{ method: "permission.reply", input: { sessionID: "ses_root", requestID: "per_top", decision: "once" } }])
  })

  test("settled in the top session leave the open list", async () => {
    const fake = fakeContext(withTop)
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.answers.push(hold)
    const opening = inbox.open()
    await settle()

    fake.state.asks = { ...empty, permissions: [bash] }
    fake.answers.push(() => undefined)
    fake.emit("permission.replied", "ses_root")
    await opening
    expect(fake.dialogs.at(-1)!.options.options.map((option: any) => [option.title, option.footer])).toEqual([["Permission: bash bun test", "depth 2 · group pair"]])
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
    await addAsksInbox(fake.context, FOLLOWS).open()

    expect(fake.dialogs[1]!.options.title).toBe("Greeting: Which greeting?")
    expect(fake.replies()).toEqual([
      { method: "answer", input: { sessionID: "ses_a", requestID: "question_1", answers: [["Hi"]] }, options: { location: { directory: "/workspace" } } },
    ])
  })

  test("takes an answer of the person's own, and several choices where the question allows them", async () => {
    const own = fakeContext({ ...empty, questions: [greeting] })
    own.answers.push(pick("Question"), pick("Type your own"), type("Good morning"))
    await addAsksInbox(own.context, FOLLOWS).open()
    expect((own.replies()[0]!.input as any).answers).toEqual([["Good morning"]])

    const several = fakeContext({ ...empty, questions: [toppings] })
    several.answers.push(pick("Question"), pick("[ ] Ham"), pick("[ ] Egg"), pick("[x] Ham"), pick("[ ] Ham"), pick("Done"))
    await addAsksInbox(several.context, FOLLOWS).open()
    expect((several.replies()[0]!.input as any).answers).toEqual([["Egg", "Ham"]])
  })

  test("says when the question no longer waits, or the answer was refused", async () => {
    const gone = fakeContext({ ...empty, questions: [greeting] })
    gone.state.answered = { answered: false }
    gone.answers.push(pick("Question"), pick("Hi"))
    await addAsksInbox(gone.context, FOLLOWS).open()
    expect(gone.toasts.map((toast) => toast.variant)).toEqual(["warning"])

    const refused = fakeContext({ ...empty, questions: [greeting] })
    refused.state.answered = { answered: false, problem: "answers needs one entry per question, 1 in all, not 2." }
    refused.answers.push(pick("Question"), pick("Hi"))
    await addAsksInbox(refused.context, FOLLOWS).open()
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
    await addAsksInbox(fake.context, FOLLOWS).open()

    expect(fake.replies()).toEqual([
      { method: "form.reply", input: { sessionID: "ses_b", formID: "frm_2", answer: { target: "prod", confirm: true, replicas: 2, regions: ["eu"] } } },
    ])
    expect(fake.toasts.map((toast) => toast.message)).toEqual(["Replicas takes a whole number"])
  })

  describe("a hidden field", () => {
    const hidden = (fields: unknown[]) => ({ id: "frm_h", sessionID: "ses_b", title: "Hidden", fields })
    const run = async (fields: unknown[], ...replies: ((dialog: any) => unknown)[]) => {
      const fake = fakeContext(empty, { ses_b: [hidden(fields)] })
      fake.answers.push(pick("Form"), ...replies)
      await addAsksInbox(fake.context, FOLLOWS).open()
      return fake
    }
    const name = { key: "name", type: "string", title: "Name" }

    test("sends its default, required or not, without asking", async () => {
      const required = await run([{ key: "token", type: "string", hidden: true, required: true, default: "abc" }, name], type("x"))
      expect(required.replies()[0]!.input).toMatchObject({ answer: { token: "abc", name: "x" } })
      expect(required.dialogs.filter((dialog) => dialog.kind === "prompt")).toHaveLength(1)

      const optional = await run([{ key: "mode", type: "string", hidden: true, default: "fast" }, name], type("x"))
      expect(optional.replies()[0]!.input).toMatchObject({ answer: { mode: "fast", name: "x" } })
    })

    test("sends nothing without a default", async () => {
      const fake = await run([{ key: "token", type: "string", hidden: true }, name], type("x"))
      expect((fake.replies()[0]!.input as any).answer).toEqual({ name: "x" })
    })

    test("is read by a `when` as its default, and not sent when its own `when` fails", async () => {
      const fake = await run(
        [
          { key: "mode", type: "string", hidden: true, default: "fast" },
          { key: "speed", type: "string", title: "Speed", when: [{ key: "mode", op: "eq", value: "fast" }] },
          { key: "slow", type: "string", title: "Slow", when: [{ key: "mode", op: "eq", value: "slow" }] },
          { key: "extra", type: "string", hidden: true, default: "e", when: [{ key: "mode", op: "eq", value: "slow" }] },
        ],
        type("quick"),
      )
      expect((fake.replies()[0]!.input as any).answer).toEqual({ mode: "fast", speed: "quick" })
    })
  })

  test("says when the form no longer waits, and does not count it answered", async () => {
    for (const _tag of ["FormNotFoundError", "FormAlreadySettledError"]) {
      const fake = fakeContext(empty, { ses_b: [{ id: "frm_g", sessionID: "ses_b", title: "Gone", fields: [{ key: "name", type: "string", title: "Name" }] }] })
      fake.state.formError = { _tag }
      fake.answers.push(pick("Form"), type("x"))
      await addAsksInbox(fake.context, FOLLOWS).open()
      expect(fake.toasts).toEqual([expect.objectContaining({ message: "It no longer waits: answered or settled some other way.", variant: "warning" })])
      expect(fake.dialogs.at(-1)!.options.title).toBe("Waiting on you (1)")
    }
  })

  test("a form that opens a page is left to its own session", async () => {
    const fake = fakeContext(empty, { ses_a: [{ id: "frm_3", sessionID: "ses_a", title: "Sign in", fields: [{ key: "login", type: "external", url: "https://example.com" }] }] })
    fake.answers.push(pick("Form"), () => undefined)
    await addAsksInbox(fake.context, FOLLOWS).open()

    expect(fake.dialogs[1]).toEqual({ kind: "alert", options: { title: "Sign in · login", message: "This form opens https://example.com: answer it in its own session." } })
    expect(fake.replies()).toEqual([])
  })
})

describe("attention", () => {
  test("a native child's new ask gets one blurred notification of the courier's, without a sound (OpenCode's plays it)", async () => {
    const fake = fakeContext(empty)
    fake.native.add("ses_a").add("ses_b")
    addAsksInbox(fake.context, FOLLOWS)
    await settle()

    fake.state.asks = { ...empty, permissions: [bash] }
    fake.emit("permission.asked")
    fake.emit("permission.asked")
    await settle()
    expect(fake.notified).toEqual([
      { title: "Root › Fix the bug › Write tests", message: "Permission: bash bun test", notification: { when: "blurred" }, sound: false },
    ])

    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    fake.emit("session.text.delta")
    await settle()
    expect(fake.notified).toHaveLength(1)
    fake.emit("form.created")
    await settle()
    expect(fake.notified.map((options) => options.message)).toEqual(["Permission: bash bun test", expect.stringContaining("Greeting")])
  })

  test("a child that is not native gets none of the courier's: OpenCode sounds and notifies it", async () => {
    const fake = fakeContext(empty)
    addAsksInbox(fake.context, FOLLOWS)
    await settle()
    fake.state.asks = { ...empty, permissions: [bash], questions: [greeting] }
    fake.emit("permission.asked")
    await settle()
    expect(fake.notified).toEqual([])
  })

  test("nothing sounds on the home screen, and its cleanup stops listening", async () => {
    const fake = fakeContext({ ...empty, permissions: [bash] })
    fake.goHome()
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    fake.emit("permission.asked")
    await settle()
    expect(fake.notified).toEqual([])

    inbox.cleanup()
    expect(fake.listeners.size).toBe(0)
  })

  test("names where an ask comes from by the sessions' current titles, the RPC's as the fallback", async () => {
    const fake = fakeContext(empty)
    const get = fake.context.data.session.get
    fake.native.add("ses_b")
    fake.context.data.session.get = (id: string) => (id === "ses_a" ? ({ id, title: "Renamed", parentID: "ses_root", location: { directory: "/workspace" } } as any) : get(id))
    const inbox = addAsksInbox(fake.context, FOLLOWS)
    await settle()
    fake.state.asks = { ...empty, permissions: [bash] }
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
    await addAsksInbox(ans.context, FOLLOWS).open()

    expect(ans.toasts[0]!.message).toBe("The answer was not passed on: closing")
  })
})

describe("a choice field's dialog says what it asks", () => {
  const ask = async (field: Record<string, unknown>, answer: (dialog: Dialog) => unknown) => {
    const form = { id: "frm_s", sessionID: "ses_a", title: "Web Search", fields: [{ key: "choice", description: "Allow OpenCode to search the web?", ...field }] }
    const fake = fakeContext(empty, { ses_a: [form] })
    fake.answers.push(pick("Form"), answer)
    await addAsksInbox(fake.context, FOLLOWS).open()
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
  await addAsksInbox(fake.context, FOLLOWS).open()
  const values = fake.dialogs[1]!.options.options.map((option: any) => option.value)
  expect(new Set(values).size).toBe(3)
  expect(fake.calls.find((call) => call.method === "form.reply")).toMatchObject({ method: "form.reply", input: { answer: { ok: true } } })
})

test("asks the fields OpenCode's form service treats as active", async () => {
  const form = {
    id: "frm_w", sessionID: "ses_b", title: "When",
    fields: [
      { key: "a", type: "string", title: "A" },
      { key: "b", type: "string", title: "B", when: [{ key: "a", op: "neq", value: "x" }] },
      { key: "langs", type: "multiselect", title: "Langs", options: [{ value: "ts", label: "TS" }, { value: "go", label: "Go" }] },
      { key: "tsconfig", type: "string", title: "TS config", required: true, when: [{ key: "langs", op: "eq", value: "ts" }] },
      { key: "nogo", type: "string", title: "No Go", when: [{ key: "langs", op: "neq", value: "go" }] },
    ],
  }
  const fake = fakeContext(empty, { ses_b: [form] })
  // a: skipped; then TS and Go picked.
  fake.answers.push(pick("Form"), type(""), pick("[ ] TS"), pick("[ ] Go"), pick("Done"), type("cfg"))
  await addAsksInbox(fake.context, FOLLOWS).open()
  expect(fake.dialogs.map((d) => d.options.title)).toEqual(["Waiting on you (1)", "When · A", "When · Langs", "When · Langs", "When · Langs", "When · TS config"])
  expect(fake.replies()[0]!.input).toMatchObject({ answer: { langs: ["ts", "go"], tsconfig: "cfg" } })
})

describe("a form field's limits", () => {
  const reply = (formID: string, answer: unknown) => [{ method: "form.reply", input: { sessionID: "ses_b", formID, answer } }]
  const run = async (field: Record<string, unknown>, ...answers: ((dialog: Dialog) => unknown)[]) => {
    const fake = fakeContext(empty, { ses_b: [{ id: "frm_l", sessionID: "ses_b", title: "L", fields: [{ key: "f", title: "F", ...field }] }] })
    fake.answers.push(pick("Form"), ...answers)
    await addAsksInbox(fake.context, FOLLOWS).open()
    return fake
  }

  test("asks a field again until its answer fits the field's limits", async () => {
    const form = {
      id: "frm_c", sessionID: "ses_b", title: "Limits",
      fields: [
        { key: "n", type: "integer", title: "N", minimum: 1, maximum: 5 },
        { key: "tags", type: "multiselect", title: "Tags", required: true, options: [{ value: "a", label: "A" }] },
        { key: "name", type: "string", title: "Name", minLength: 3, pattern: "^[a-z]+$" },
      ],
    }
    const fake = fakeContext(empty, { ses_b: [form] })
    fake.answers.push(pick("Form"), type("0"), type("2"), pick("Done"), pick("[ ] A"), pick("Done"), type("X1"), type("abc"))
    await addAsksInbox(fake.context, FOLLOWS).open()
    expect(fake.replies()).toEqual([{ method: "form.reply", input: { sessionID: "ses_b", formID: "frm_c", answer: { n: 2, tags: ["a"], name: "abc" } } }])
    expect(fake.toasts.map((toast) => [toast.variant, toast.message])).toEqual([
      ["warning", "N: Must be at least 1"],
      ["warning", "Tags: Select at least one option"],
      ["warning", "Name: Must be at least 3 characters"],
    ])
  })

  test("a number above its maximum is asked again", async () => {
    const fake = await run({ type: "number", maximum: 2.5 }, type("3"), type("2"))
    expect(fake.toasts.map((toast) => toast.message)).toEqual(["F: Must be at most 2.5"])
    expect(fake.replies()).toEqual(reply("frm_l", { f: 2 }))
  })

  test("a text longer than its maximum length is asked again", async () => {
    const fake = await run({ type: "string", maxLength: 3 }, type("abcd"), type("abc"))
    expect(fake.toasts.map((toast) => toast.message)).toEqual(["F: Must be at most 3 characters"])
    expect(fake.replies()).toEqual(reply("frm_l", { f: "abc" }))
  })

  test.each([
    ["email", "nope", "a@b.de", "Expected an email address"],
    ["uri", "no uri", "https://x.test", "Expected a URL"],
    ["date", "2026-02-30", "2026-02-28", "Expected a date (YYYY-MM-DD)"],
    ["date-time", "later", "2026-02-28T10:00:00Z", "Expected a date and time"],
  ])("a %s format is checked", async (format, bad, good, message) => {
    const fake = await run({ type: "string", format }, type(bad), type(good))
    expect(fake.toasts.map((toast) => toast.message)).toEqual([`F: ${message}`])
    expect(fake.replies()).toEqual(reply("frm_l", { f: good }))
  })

  test("a multiselect with too few or too many picks is asked again", async () => {
    const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }]
    const fake = await run(
      { type: "multiselect", minItems: 2, maxItems: 2, options },
      pick("[ ] A"), pick("Done"), pick("[ ] A"), pick("[ ] B"), pick("[ ] C"), pick("Done"), pick("[ ] A"), pick("[ ] B"), pick("Done"),
    )
    expect(fake.toasts.map((toast) => toast.message)).toEqual(["F: Select at least 2", "F: Select at most 2"])
    expect(fake.replies()).toEqual(reply("frm_l", { f: ["a", "b"] }))
  })

  test("an optional multiselect left empty is skipped, whatever its minimum", async () => {
    const fake = await run({ type: "multiselect", minItems: 2, options: [{ value: "a", label: "A" }] }, pick("Done"))
    expect(fake.toasts).toEqual([])
    expect(fake.replies()).toEqual(reply("frm_l", {}))
  })

  test("a typed field's prompt shows its limits as the placeholder", async () => {
    const placeholders = async (field: Record<string, unknown>) => (await run(field, () => undefined)).dialogs[1]!.options.placeholder
    expect(await placeholders({ type: "integer", minimum: 1, maximum: 5 })).toBe("1-5")
    expect(await placeholders({ type: "number", minimum: 0 })).toBe("at least 0")
    expect(await placeholders({ type: "string", minLength: 3, maxLength: 9, format: "email" })).toBe("3-9 characters, email")
    expect(await placeholders({ type: "string" })).toBeUndefined()
  })
})

describe("a form field's default", () => {
  test("starts each field on its default", async () => {
    const form = {
      id: "frm_d", sessionID: "ses_b", title: "Defaults",
      fields: [
        { key: "n", type: "integer", title: "N", default: 3 },
        { key: "ok", type: "boolean", title: "OK", default: true },
        { key: "tags", type: "multiselect", title: "Tags", default: ["a"], options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      ],
    }
    const fake = fakeContext(empty, { ses_b: [form] })
    fake.answers.push(pick("Form"), (dialog) => dialog.options.value, (dialog) => dialog.options.current, pick("Done"))
    await addAsksInbox(fake.context, FOLLOWS).open()
    expect(fake.dialogs[1]!.options.value).toBe("3")
    expect(fake.dialogs[2]!.options.current).toBe(true)
    expect(fake.dialogs[3]!.options.options.map((option: any) => option.title)).toEqual(["[x] A", "[ ] B", "Done"])
    expect(fake.replies()[0]!.input).toMatchObject({ answer: { n: 3, ok: true, tags: ["a"] } })
  })

  test("a string with options starts on its default, which may be the person's own earlier value", async () => {
    const options = [{ value: "prod", label: "Production" }, { value: "dev", label: "Development" }]
    const form = {
      id: "frm_e", sessionID: "ses_b", title: "Env",
      fields: [{ key: "env", type: "string", title: "Env", default: "dev", options }, { key: "other", type: "string", title: "Other", default: "qa", custom: true, options }],
    }
    const fake = fakeContext(empty, { ses_b: [form] })
    fake.answers.push(pick("Form"), (dialog) => dialog.options.current, (dialog) => dialog.options.current)
    await addAsksInbox(fake.context, FOLLOWS).open()
    expect(fake.dialogs[1]!.options.current).toBe("dev")
    expect(fake.dialogs[2]!.options.current).toBe("qa")
    expect(fake.dialogs[2]!.options.options.map((option: any) => option.title)).toContain("[x] qa")
    expect(fake.replies()[0]!.input).toMatchObject({ answer: { env: "dev", other: "qa" } })
  })

  test("a field without a default starts empty", async () => {
    const fake = fakeContext(empty, { ses_b: [{ id: "frm_n", sessionID: "ses_b", title: "N", fields: [{ key: "n", type: "number", title: "N" }, { key: "ok", type: "boolean", title: "OK" }] }] })
    fake.answers.push(pick("Form"), () => undefined)
    await addAsksInbox(fake.context, FOLLOWS).open()
    expect(fake.dialogs[1]!.options).toEqual({ title: "N · N" })
  })
})

test("an unrelated request does not sound asks that were already waiting", async () => {
  const fake = fakeContext({ ...empty, permissions: [bash], questions: [greeting] })
  addAsksInbox(fake.context, FOLLOWS)
  await settle()
  // A permission request in a session outside this tree; the tree's two asks were there before.
  fake.emit("permission.asked", "ses_elsewhere")
  await settle()
  expect(fake.notified).toEqual([])
})

test("the first ask in a tree reached after start sounds, the ones already waiting there do not", async () => {
  const fake = fakeContext({ ...empty, permissions: [bash], questions: [greeting] })
  fake.native.add("ses_a")
  fake.goHome()
  addAsksInbox(fake.context, FOLLOWS)
  await settle()
  fake.goSession("ses_root")
  // bash waits in ses_b; the event names the session of the new ask.
  fake.emit("form.created", "ses_a")
  await settle()
  expect(fake.notified.map((options) => options.message)).toEqual([expect.stringContaining("Greeting")])
})
