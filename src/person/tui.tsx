import type { Plugin } from "@opencode/plugin/tui"
import { personRpc, type AskedPermission, type AskedQuestion, type Asks, type TreeSession } from "./rpc.js"
import { REJECTED } from "./text.js"

type Context = Plugin.Context
type FormInfo = NonNullable<ReturnType<Context["data"]["session"]["form"]["list"]>>[number]
type FormField = FormInfo["fields"][number]
type FormAnswer = Parameters<Context["data"]["session"]["form"]["reply"]>[0]["answer"]
type FormValue = FormAnswer[string]

/**
 * Something a session of the tree waits on the person for; `key` is unique across kinds. `prompted` marks a permission
 * request the top session's courier_answer prompt asks about.
 */
export type Ask = { readonly key: string; readonly session: TreeSession } & (
  | { readonly kind: "permission"; readonly request: AskedPermission; readonly prompted?: boolean }
  | { readonly kind: "question"; readonly question: AskedQuestion }
  | { readonly kind: "form"; readonly form: FormInfo }
)

/** The `metadata.kind` of the forms OpenCode's question tool asks with: the relay lists those as questions. */
const QUESTION_FORM = "question"

/** The command that opens the inbox, from its key, its slash command, the palette or the footer. */
export const INBOX_COMMAND = "courier.asks"

/** How long after the first of a burst of asks the inbox reads the tree again, to sound the new ones. */
export const SETTLE_MS = 250

/** The top session, at depth 0, as its own permission requests name it. */
export const topSession = (asks: Asks): TreeSession => ({ sessionID: asks.top, title: "", parentID: "", depth: 0 })

/**
 * The asks of a tree in the order the inbox lists them: the top session's own permission requests, then by the tree's
 * order, each session's permissions, questions, then forms.
 */
export function asksOf(asks: Asks, forms: ReadonlyMap<string, ReadonlyArray<FormInfo>>): Ask[] {
  const prompting = new Set(asks.permissions.flatMap((request) => (request.sessionID === asks.top && request.passesOn ? [request.passesOn.requestID] : [])))
  return [topSession(asks), ...asks.sessions].flatMap((session): Ask[] => [
    ...asks.permissions
      .filter((request) => request.sessionID === session.sessionID)
      .map((request) => ({
        kind: "permission" as const,
        key: `permission ${request.requestID}`,
        session,
        request,
        ...(session.depth > 0 && prompting.has(request.requestID) ? { prompted: true } : {}),
      })),
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
      const { action, resources, passesOn } = ask.request
      const what = resources.length ? `${action} ${resources.join(", ")}` : action
      if (ask.session.depth > 0) return clip(`Permission: ${what}`)
      return clip(passesOn ? `Permission (top session): courier_answer once for "${what}"` : `Permission (top session): ${what}`)
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

/** The line under an ask: its depth (the top's own say so) and group, that a question's call was cut off, or that the top's courier_answer prompt asks for it. */
export function askFooter(ask: Ask) {
  const top = ask.session.depth === 0
  return [
    top ? "top session" : `depth ${ask.session.depth}`,
    ask.session.group ? `group ${ask.session.group}` : "",
    ask.kind === "permission" && ask.prompted ? "the top's prompt asks" : "",
    ask.kind === "question" && ask.question.stopped ? "cut off, answered by message" : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Whether a form field applies, given the answers so far (a hidden field's default among them): its `when` conditions hold, as OpenCode reads them (a condition on an unanswered field is false; on a multiselect, `eq` means includes). */
export function active(field: FormField, answers: FormAnswer) {
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
 * answered in dialogs, opened by its command, its open list read again on `follows`; a sound for each new ask.
 */
export function addAsksInbox(ctx: Context, follows: ReadonlySet<string>) {
  const person = ctx.client.rpc(personRpc)
  const currentTitle = (sessionID: string) => ctx.data.session.get(sessionID)?.title
  // Where the session runs, which has the plugin loaded, as the footer asks.
  const location = (sessionID: string) => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  const openSession = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  // When the inbox first saw each ask, so it lists the oldest first after the top's own; and those it answered, which the server may list a moment longer.
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
    // The top's own requests first, as they hold up the sessions below.
    const rank = (ask: Ask) => (ask.session.depth === 0 ? 0 : 1)
    listed.sort((a, b) => rank(a) - rank(b) || firstSeen.get(a.key)! - firstSeen.get(b.key)!)
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
      if (!active(field, answer)) continue
      if ("hidden" in field && field.hidden) {
        // Not asked, as OpenCode's form view submits it: its default, when it has one.
        if ("default" in field && field.default !== undefined) answer[field.key] = field.default
        continue
      }
      const value = await answerField(form, field)
      if (value === undefined) return false
      if (value !== SKIP) answer[field.key] = value
    }
    // The client, not the data layer's reply, which resolves when the form is gone.
    try {
      await ctx.client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer })
    } catch (error) {
      const tag = (error as { _tag?: unknown } | undefined)?._tag
      if (tag !== "FormNotFoundError" && tag !== "FormAlreadySettledError") throw error
      ctx.ui.toast.show({ title: "courier", message: "It no longer waits: answered or settled some other way.", variant: "warning" })
      return false
    }
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

  type Found = Awaited<ReturnType<typeof read>>
  /** The list on screen: its tree, its asks' keys, and how to show a newer read of it in its place. */
  let listing: { readonly sessionID: string; readonly keys: string; readonly replace: (found: Found) => void } | undefined
  let following: ReturnType<typeof setTimeout> | undefined
  const keysOf = (listed: ReadonlyArray<Ask>) => listed.map((ask) => ask.key).join("\n")
  let reads = 0
  /** Reads the tree of the list on screen again, and shows the new list when its asks changed; of overlapping reads, the last. */
  const follow = async () => {
    const sessionID = listing?.sessionID
    if (!sessionID) return
    const ticket = ++reads
    const found = await read(sessionID)
    const shown = listing
    if (ticket === reads && shown?.sessionID === sessionID && keysOf(found.listed) !== shown.keys) shown.replace(found)
  }

  /** Shows the list of `found` and waits for the person's choice, or for a newer read of the tree to show in its place. */
  async function showList(sessionID: string, { asks, listed }: Found) {
    let replace: (found: Found) => void = () => undefined
    const newer = new Promise<Found>((resolve) => {
      replace = resolve
    })
    listing = { sessionID, keys: keysOf(listed), replace }
    const top = ctx.data.session.get(asks.top)?.title ?? asks.top
    const choosing = ctx.ui.dialog.select<Ask>({
      title: `Waiting on you (${listed.length})`,
      placeholder: "Search",
      options: listed.map((ask) => ({ title: askTitle(ask), value: ask, description: pathOf(asks, ask.session.sessionID, top, currentTitle), footer: askFooter(ask) })),
    })
    // Wider than a dialog opens, for where each ask comes from.
    ctx.ui.dialog.set({ size: "large" })
    try {
      // A newer list replaces this one, whose select then resolves with nothing.
      return await Promise.race([choosing.then((chosen) => ({ chosen })), newer.then((read) => ({ read }))])
    } finally {
      listing = undefined
    }
  }

  /** Answers the ask chosen; one answered is not listed again, though the server may list it a moment longer. */
  async function answerChosen(chosen: Ask) {
    const done = await answer(chosen).catch((error: unknown) => {
      fail("The answer was not passed on")(error)
      return false
    })
    if (done) answered.add(chosen.key)
  }

  let opened = false
  /**
   * Lists the asks of the open session's tree, answers the one chosen, and lists what is left, until none is or the person
   * leaves; while the list is shown it follows the tree, shown again as asks arrive or are settled elsewhere.
   */
  async function open(sessionID = openSession()) {
    if (!sessionID) {
      ctx.ui.toast.show({ title: "courier", message: "Open a session to see what its sessions ask you.", variant: "info" })
      return
    }
    if (opened) return
    opened = true
    try {
      let found = await read(sessionID).catch(fail("The asks could not be read"))
      let first = true
      // Whether the last read replaces a list still on screen.
      let shown = false
      while (found?.listed.length) {
        first = false
        const next = await showList(sessionID, found)
        shown = "read" in next
        if ("read" in next) {
          found = next.read
          continue
        }
        if (!next.chosen) return
        await answerChosen(next.chosen)
        found = await read(sessionID).catch(fail("The asks could not be read"))
      }
      if (!found) return
      if (first) ctx.ui.toast.show({ title: "courier", message: "Nothing in this courier tree waits on you.", variant: "info" })
      // All settled elsewhere while it was shown: the list closes.
      if (shown) ctx.ui.dialog.clear()
    } finally {
      opened = false
      clearTimeout(following)
      following = undefined
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
      // OpenCode sounds every ask and notifies for a session that is not a native child; the courier adds
      // the tree path as a notification for a native child, whose OpenCode one is off.
      if (!ctx.data.session.get(ask.session.sessionID)?.parentID) continue
      void ctx.attention.notify({
        title: pathOf(asks, ask.session.sessionID, top, currentTitle),
        message: askTitle(ask),
        notification: { when: "blurred" },
        sound: false,
      })
    }
  }
  void sound().catch(() => undefined)
  const unlisten = ctx.data.listen(({ details }) => {
    if (listing && follows.has(details.type) && !following)
      following = setTimeout(() => {
        following = undefined
        void follow().catch(() => undefined)
      }, SETTLE_MS)
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
      clearTimeout(following)
      unlisten()
    },
  }
}
