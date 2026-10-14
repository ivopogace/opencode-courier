import type { Plugin } from "@opencode/plugin/tui"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"
import { personRpc, type AskedPermission, type AskedQuestion, type Asks, type TreeSession } from "./rpc.js"
import { REJECTED } from "./text.js"

type Context = Plugin.Context
type FormInfo = NonNullable<ReturnType<Context["data"]["session"]["form"]["list"]>>[number]
type FormField = FormInfo["fields"][number]
type FormAnswer = Parameters<Context["data"]["session"]["form"]["reply"]>[0]["answer"]
type FormValue = FormAnswer[string]

/** Something a session of the tree waits on the person for; `key` is unique across kinds. */
export type Ask = { readonly key: string; readonly session: TreeSession } & (
  | { readonly kind: "permission"; readonly request: AskedPermission }
  | { readonly kind: "question"; readonly question: AskedQuestion }
  | { readonly kind: "form"; readonly form: FormInfo }
)

/** The `metadata.kind` of the forms OpenCode's question tool asks with: the relay lists those as questions. */
const QUESTION_FORM = "question"

/** The command that opens the inbox, from its key, its slash command, the palette or the footer. */
export const INBOX_COMMAND = "courier.asks"

/** How long after the first of a burst of asks the inbox reads the tree again, to sound the new ones. */
export const SETTLE_MS = 250

/** The asks of a tree in the order the inbox lists them: by the tree's order, each session's permissions, questions, then forms. */
export function asksOf(asks: Asks, forms: ReadonlyMap<string, ReadonlyArray<FormInfo>>): Ask[] {
  return asks.sessions.flatMap((session): Ask[] => [
    ...asks.permissions
      .filter((request) => request.sessionID === session.sessionID)
      .map((request) => ({ kind: "permission" as const, key: `permission ${request.requestID}`, session, request })),
    ...asks.questions
      .filter((question) => question.sessionID === session.sessionID)
      .map((question) => ({ kind: "question" as const, key: `question ${question.requestID}`, session, question })),
    ...(forms.get(session.sessionID) ?? [])
      .filter((form) => form.metadata?.kind !== QUESTION_FORM)
      .map((form) => ({ kind: "form" as const, key: `form ${form.id}`, session, form })),
  ])
}

/** Where an ask comes from: the titles from the top session down to the asking one, as "root › child › grandchild", each as the TUI knows it now, else as spawned. */
export function pathOf(asks: Asks, sessionID: string, topTitle: string, currentTitle: (sessionID: string) => string | undefined = () => undefined) {
  const byID = new Map(asks.sessions.map((session) => [session.sessionID, session]))
  const titles: string[] = []
  for (let at = byID.get(sessionID); at && titles.length <= byID.size; at = byID.get(at.parentID)) titles.unshift(currentTitle(at.sessionID) || at.title)
  return [topTitle, ...titles].join(" › ")
}

const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** What an ask is, in one line. */
export function askTitle(ask: Ask) {
  switch (ask.kind) {
    case "permission": {
      const { action, resources } = ask.request
      return clip(resources.length ? `Permission: ${action} ${resources.join(", ")}` : `Permission: ${action}`)
    }
    case "question": {
      const [first, ...rest] = ask.question.questions
      const what = first ? `${first.header}: ${first.question}` : ask.question.requestID
      const more = rest.length ? ` (+${rest.length} more)` : ""
      return clip(`Question: ${what}${more}`)
    }
    case "form":
      return clip(`Form: ${ask.form.title}`)
  }
}

/** The line under an ask: its depth and group, and that a question's call was cut off. */
export function askFooter(ask: Ask) {
  return [
    `depth ${ask.session.depth}`,
    ask.session.group ? `group ${ask.session.group}` : "",
    ask.kind === "question" && ask.question.stopped ? "cut off, answered by message" : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The sound an ask arriving plays: a permission request's, or a question's for questions and forms. */
export const soundOf = (ask: Ask): AttentionSoundName => (ask.kind === "permission" ? "permission" : "question")

/** Whether a form field is shown, given the answers so far: hidden ones never, conditional ones when their conditions hold, as OpenCode reads them (a condition on an unanswered field is false; on a multiselect, `eq` means includes). */
export function shown(field: FormField, answers: FormAnswer) {
  if ("hidden" in field && field.hidden) return false
  const when = "when" in field ? (field.when ?? []) : []
  return when.every(({ key, op, value }) => {
    const answer = answers[key]
    if (answer === undefined) return false
    const hit = Array.isArray(answer) ? answer.some((item) => item === value) : answer === value
    return op === "eq" ? hit : !hit
  })
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isDate = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) === text

/** What is wrong with a field's answer by the limits OpenCode's form service checks on reply, worded as its form view does; undefined when it fits. */
export function misfit(field: FormField, value: FormValue): string | undefined {
  if (field.type === "string") {
    if (typeof value !== "string") return "Expected text"
    if (field.required && !value) return "Answer required"
    if (field.minLength !== undefined && value.length < field.minLength) return `Must be at least ${field.minLength} characters`
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Must be at most ${field.maxLength} characters`
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Must match pattern: ${field.pattern}`
      } catch {
        return `Invalid pattern: ${field.pattern}`
      }
    }
    if (field.format === "email" && !EMAIL.test(value)) return "Expected an email address"
    if (field.format === "uri" && !URL.canParse(value)) return "Expected a URL"
    if (field.format === "date" && !isDate(value)) return "Expected a date (YYYY-MM-DD)"
    if (field.format === "date-time" && Number.isNaN(new Date(value).getTime())) return "Expected a date and time"
    return undefined
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Expected a number"
    if (field.type === "integer" && !Number.isInteger(value)) return "Expected an integer"
    if (typeof field.minimum === "number" && value < field.minimum) return `Must be at least ${field.minimum}`
    if (typeof field.maximum === "number" && value > field.maximum) return `Must be at most ${field.maximum}`
    return undefined
  }
  if (field.type === "multiselect") {
    if (!Array.isArray(value)) return "Expected selections"
    if (field.required && !value.length) return "Select at least one option"
    if (field.minItems !== undefined && value.length < field.minItems) return `Select at least ${field.minItems}`
    if (field.maxItems !== undefined && value.length > field.maxItems) return `Select at most ${field.maxItems}`
  }
  return undefined
}

const numberOf = (limit: unknown) => (typeof limit === "number" ? limit : undefined)

/** The limits of a typed field as a prompt's placeholder: "1-5", "at least 3 characters", "email"; undefined without any. */
export function limitsOf(field: FormField): string | undefined {
  const range = (low: number | undefined, high: number | undefined, unit = "") => {
    if (low !== undefined && high !== undefined) return `${low}-${high}${unit}`
    if (low !== undefined) return `at least ${low}${unit}`
    if (high !== undefined) return `at most ${high}${unit}`
    return undefined
  }
  const parts =
    field.type === "number" || field.type === "integer"
      ? [range(numberOf(field.minimum), numberOf(field.maximum))]
      : field.type === "string"
        ? [range(field.minLength, field.maxLength, " characters"), field.format, field.pattern ? `/${field.pattern}/` : undefined]
        : []
  return parts.filter(Boolean).join(", ") || undefined
}

/** A choice offered for a question or a form field: shown by its label, answered with its value. */
type Choice = { readonly label: string; readonly value: string; readonly description?: string }

/** The options of one round of `choose`: the choices, marked when several may be picked, then the extra ones. */
function chooseOptions(choices: ReadonlyArray<Choice>, picked: ReadonlyArray<string>, { multiple = false, own = false, optional = false }) {
  const mark = (value: string) => {
    if (!multiple) return ""
    return picked.includes(value) ? "[x] " : "[ ] "
  }
  const theirs = picked.filter((value) => !choices.some((choice) => choice.value === value))
  return [
    ...choices.map((choice) => ({
      title: `${mark(choice.value)}${choice.label}`,
      value: choice.value as string | symbol,
      ...(choice.description ? { description: choice.description } : {}),
    })),
    ...theirs.map((value) => ({ title: `[x] ${value}`, value: value as string | symbol })),
    ...(own ? [{ title: "Type your own answer…", value: OWN as string | symbol }] : []),
    ...(multiple ? [{ title: "Done", value: DONE as string | symbol, description: picked.length ? picked.join(", ") : "nothing chosen" }] : []),
    ...(optional && !multiple ? [{ title: "Skip", value: SKIP as string | symbol }] : []),
  ]
}

/** Picks `value` if it is not picked, else unpicks it. */
function toggle(picked: string[], value: string) {
  const at = picked.indexOf(value)
  if (at >= 0) picked.splice(at, 1)
  else picked.push(value)
}

/** The choice that leads to a prompt for an answer of the person's own. */
const OWN = Symbol("own")
/** The choice that ends a multiple choice. */
const DONE = Symbol("done")
/** The choice that leaves a field that is not required unanswered. */
const SKIP = Symbol("skip")
/** The disabled first option carrying a field's description; never chosen. */
const NOTE = Symbol("note")

/**
 * Adds the asks inbox: what the open session's courier tree waits on the person for, read through the person's RPC and
 * answered in dialogs, opened by its command; a sound for each new ask. Returns its opener and its cleanup.
 */
export function addAsksInbox(ctx: Context) {
  const person = ctx.client.rpc(personRpc)
  const currentTitle = (sessionID: string) => ctx.data.session.get(sessionID)?.title
  // Where the session runs, which has the plugin loaded, as the footer asks.
  const location = (sessionID: string) => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  const openSession = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  // When the inbox first saw each ask, so it lists the oldest first; and those it answered, which the server may list a moment longer.
  const firstSeen = new Map<string, number>()
  const answered = new Set<string>()
  let seen = 0

  async function read(sessionID: string) {
    const asks = await person.asks({ sessionID }, { location: location(sessionID) })
    const forms = new Map(
      await Promise.all(
        asks.sessions.map(
          async (session) => [session.sessionID, await ctx.client.session.form.list({ sessionID: session.sessionID }).catch(() => [])] as const,
        ),
      ),
    )
    const listed = asksOf(asks, forms).filter((ask) => !answered.has(ask.key))
    for (const ask of listed) if (!firstSeen.has(ask.key)) firstSeen.set(ask.key, seen++)
    listed.sort((a, b) => firstSeen.get(a.key)! - firstSeen.get(b.key)!)
    return { asks, listed }
  }

  /** The host's client throws an RPC error as a plain `{ type, message }` object, not an `Error`. */
  const reason = (error: unknown) => {
    if (error instanceof Error) return error.message
    return typeof error === "object" && error && "message" in error ? String(error.message) : String(error)
  }

  const fail = (what: string) => (error: unknown) =>
    ctx.ui.toast.show({ title: "courier", message: `${what}: ${reason(error)}`, variant: "error" })

  /**
   * Asks the person to pick one or more of `choices`, each answered with its value, or to give an answer of their
   * own; undefined when they back out, an empty list when they skip an optional one.
   */
  async function choose(
    title: string,
    choices: ReadonlyArray<Choice>,
    { multiple = false, own = false, optional = false, asks = "", start = [] as ReadonlyArray<string> } = {},
  ) {
    const picked = [...start]
    for (;;) {
      const value = await ctx.ui.dialog.select<string | symbol>({
        title,
        ...(!multiple && start[0] !== undefined ? { current: start[0] } : {}),
        options: [...(asks ? [{ title: asks, value: NOTE, disabled: true }] : []), ...chooseOptions(choices, picked, { multiple, own, optional })],
      })
      if (value === undefined) return undefined
      if (value === DONE) return picked
      if (value === SKIP) return []
      const chosen = value === OWN ? (await ctx.ui.dialog.prompt({ title, placeholder: "Your answer" }))?.trim() : (value as string)
      if (!chosen) continue
      if (!multiple) return [chosen]
      toggle(picked, chosen)
    }
  }

  async function answerPermission(ask: Extract<Ask, { kind: "permission" }>) {
    const { request } = ask
    const decision = await ctx.ui.dialog.select<"once" | "always" | "reject" | "reason">({
      title: askTitle(ask),
      options: [
        { title: "Allow once", value: "once" },
        ...(request.save?.length ? [{ title: "Always allow", value: "always" as const, description: request.save.join(", ") }] : []),
        { title: "Reject", value: "reject", description: "the session's call fails and it carries on" },
        { title: "Reject with a reason…", value: "reason" },
      ],
    })
    if (decision === undefined) return false
    const message = decision === "reason" ? await ctx.ui.dialog.prompt({ title: "Why not?", placeholder: "Passed on to the session" }) : undefined
    if (decision === "reason" && message === undefined) return false
    const reply = decision === "reason" ? "reject" : decision
    // With a reason, a refusal fails the call and the session carries on; a bare one would end its turn.
    await ctx.client.permission.reply({
      sessionID: request.sessionID,
      requestID: request.requestID,
      decision: reply,
      ...(reply === "reject" ? { message: message?.trim() || REJECTED } : {}),
    })
    return true
  }

  async function answerQuestion(ask: Extract<Ask, { kind: "question" }>) {
    const { question } = ask
    const answers: string[][] = []
    for (const [index, prompt] of question.questions.entries()) {
      const count = question.questions.length > 1 ? ` (${index + 1}/${question.questions.length})` : ""
      const choices = prompt.options.map((option) => ({ ...option, value: option.label }))
      const picked = await choose(`${prompt.header}: ${prompt.question}${count}`, choices, { multiple: !!prompt.multiple, own: true })
      if (picked === undefined) return false
      answers.push(picked)
    }
    const result = await person.answer(
      { sessionID: question.sessionID, requestID: question.requestID, answers },
      { location: location(question.sessionID) },
    )
    if (result.problem) throw new Error(result.problem)
    if (!result.answered) ctx.ui.toast.show({ title: "courier", message: "It no longer waits: answered or settled some other way.", variant: "warning" })
    return true
  }

  /** Typed text for a field, asked again while empty and required; undefined when the person backs out. */
  async function typed(title: string, field: { description?: string; default?: string; placeholder?: string }, optional: boolean) {
    for (;;) {
      const text = await ctx.ui.dialog.prompt({
        title,
        ...(field.description ? { description: field.description } : {}),
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        ...(field.default ? { value: field.default } : {}),
      })
      if (text === undefined) return undefined
      if (text || optional) return text || SKIP
    }
  }

  /** A number for a field, a whole one for an integer, asked again until it is one. */
  async function numeric(title: string, field: Extract<FormField, { type: "number" | "integer" }>, optional: boolean) {
    const label = field.title ?? field.key
    const whole = field.type === "integer"
    for (;;) {
      const text = await typed(title, { ...(field.description ? { description: field.description } : {}), ...placeholder(field), ...(field.default !== undefined ? { default: String(field.default) } : {}) }, optional)
      if (text === undefined || text === SKIP) return text
      const value = Number(text)
      if (Number.isFinite(value) && (!whole || Number.isInteger(value))) return value
      ctx.ui.toast.show({ title: "courier", message: `${label} takes ${whole ? "a whole number" : "a number"}`, variant: "warning" })
    }
  }

  const placeholder = (field: FormField) => {
    const limits = limitsOf(field)
    return limits ? { placeholder: limits } : {}
  }

  /** The person's answer to one field, asked again with a warning until it fits the field's limits; undefined when they back out, `SKIP` for none. */
  async function answerField(form: { title?: string }, field: FormField): Promise<FormValue | typeof SKIP | undefined> {
    for (;;) {
      const value = await askField(form, field)
      if (value === undefined || value === SKIP) return value
      const problem = misfit(field, value)
      if (!problem) return value
      ctx.ui.toast.show({ title: "courier", message: `${field.title ?? field.key}: ${problem}`, variant: "warning" })
    }
  }

  async function askField(form: { title?: string }, field: FormField): Promise<FormValue | typeof SKIP | undefined> {
    const label = field.title ?? field.key
    const title = form.title ? `${form.title} · ${label}` : label
    const asks = field.description ?? ""
    const optional = !("required" in field && field.required)
    switch (field.type) {
      case "external":
        await ctx.ui.dialog.alert({ title, message: `This form opens ${field.url}: answer it in its own session.` })
        return undefined
      case "boolean":
        return ctx.ui.dialog.select<boolean | symbol>({
          title,
          ...(field.default !== undefined ? { current: field.default } : {}),
          options: [...(asks ? [{ title: asks, value: NOTE, disabled: true }] : []), { title: "Yes", value: true }, { title: "No", value: false }],
        }) as Promise<boolean | undefined>
      case "multiselect": {
        const picked = await choose(title, field.options, { multiple: true, own: !!field.custom, asks, start: field.default ?? [] })
        if (picked?.length === 0 && optional) return SKIP
        return picked
      }
      case "string": {
        if (!field.options?.length) return typed(title, { ...field, ...placeholder(field) }, optional)
        const picked = await choose(title, field.options, { own: !!field.custom, optional, asks, start: field.default === undefined ? [] : [field.default] })
        return picked && (picked[0] ?? SKIP)
      }
      case "number":
      case "integer":
        return numeric(title, field, optional)
    }
  }

  async function answerForm(ask: Extract<Ask, { kind: "form" }>) {
    const { form } = ask
    const answer: Record<string, FormValue> = {}
    for (const field of form.fields) {
      if (!shown(field, answer)) continue
      const value = await answerField(form, field)
      if (value === undefined) return false
      if (value !== SKIP) answer[field.key] = value
    }
    await ctx.data.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer })
    return true
  }

  const answer = (ask: Ask) => {
    switch (ask.kind) {
      case "permission":
        return answerPermission(ask)
      case "question":
        return answerQuestion(ask)
      case "form":
        return answerForm(ask)
    }
  }

  let opened = false
  /** Lists the asks of the open session's tree, answers the one chosen, and lists what is left, until none is or the person leaves. */
  async function open(sessionID = openSession()) {
    if (!sessionID) {
      ctx.ui.toast.show({ title: "courier", message: "Open a session to see what its sessions ask you.", variant: "info" })
      return
    }
    if (opened) return
    opened = true
    try {
      for (let first = true; ; first = false) {
        const found = await read(sessionID).catch(fail("The asks could not be read"))
        if (!found) return
        const { asks, listed } = found
        if (!listed.length) {
          if (first) ctx.ui.toast.show({ title: "courier", message: "Nothing in this courier tree waits on you.", variant: "info" })
          return
        }
        const top = ctx.data.session.get(asks.top)?.title ?? asks.top
        const choosing = ctx.ui.dialog.select<Ask>({
          title: `Waiting on you (${listed.length})`,
          placeholder: "Search",
          options: listed.map((ask) => ({ title: askTitle(ask), value: ask, description: pathOf(asks, ask.session.sessionID, top, currentTitle), footer: askFooter(ask) })),
        })
        // Wider than a dialog opens, for where each ask comes from.
        ctx.ui.dialog.set({ size: "large" })
        const chosen = await choosing
        if (!chosen) return
        const done = await answer(chosen).catch((error: unknown) => {
          fail("The answer was not passed on")(error)
          return false
        })
        if (done) answered.add(chosen.key)
      }
    } finally {
      opened = false
    }
  }

  // A new ask in the open session's tree sounds once: read after a burst of asks, the ones not seen before.
  // A tree's first read only records the asks waiting there, except those in sessions the events named.
  const sounded = new Set<string>()
  const readTops = new Set<string>()
  let named = new Set<string>()
  let settling: ReturnType<typeof setTimeout> | undefined
  const sound = async () => {
    const sessionID = openSession()
    if (!sessionID) {
      named.clear()
      return
    }
    const { asks, listed } = await read(sessionID)
    const eventSessions = named
    named = new Set()
    const top = ctx.data.session.get(asks.top)?.title ?? asks.top
    const first = !readTops.has(asks.top)
    readTops.add(asks.top)
    for (const ask of listed) {
      if (sounded.has(ask.key)) continue
      sounded.add(ask.key)
      if (first && !eventSessions.has(ask.session.sessionID)) continue
      void ctx.attention.notify({
        title: pathOf(asks, ask.session.sessionID, top, currentTitle),
        message: askTitle(ask),
        notification: { when: "blurred" },
        sound: { name: soundOf(ask), when: "always" },
      })
    }
  }
  void sound().catch(() => undefined)
  const unlisten = ctx.data.listen(({ details }) => {
    if (details.type !== "permission.asked" && details.type !== "form.created") return
    const data = (details as { data?: { sessionID?: string; form?: { sessionID?: string } } }).data
    const eventSession = data?.sessionID ?? data?.form?.sessionID
    if (eventSession) named.add(eventSession)
    if (settling) return
    settling = setTimeout(() => {
      settling = undefined
      void sound().catch(() => undefined)
    }, SETTLE_MS)
  })

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: INBOX_COMMAND,
        title: "Courier: what waits on you",
        description: "Answer the permission requests, questions and forms of the sessions started with courier",
        group: "Courier",
        bind: "<leader>k",
        palette: true,
        slash: { name: "asks", aliases: ["ask"] },
        run: () => void open(),
      },
    ],
  }))

  return {
    open,
    cleanup: () => {
      clearTimeout(settling)
      unlisten()
    },
  }
}
