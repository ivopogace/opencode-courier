import { envelope } from "../kernel/protocol.js"
import { claim, SEEN_MAX, setBounded } from "../platform/bounded.js"
import { lineage, nativeRootOf, type ShownForm } from "../tree/index.js"
import { topOf, type Form, type FormsShown, type PersonPorts, type PersonState } from "./ports.js"
import { formNotice, formSettledNotice, kindOf } from "./text.js"

/** The `metadata.kind` of the forms OpenCode's question tool asks with; the question relay passes those on. */
export const QUESTION_FORM = "question"

/** The part of OpenCode's `form.created` event the notice is made from. */
export interface FormCreated {
  readonly id: string
  readonly data: { readonly form: Form }
}

/** OpenCode's `form.replied` or `form.cancelled` event: the form is no longer shown. */
export interface FormSettled {
  readonly id: string
  readonly type: string
  readonly data: { readonly id: string; readonly sessionID: string }
}

/**
 * Tells the top session about a form OpenCode shows in a spawned session, such as web search asking
 * for its provider, which only the person can answer; question forms are left to the question relay.
 */
export async function reportForm(ports: PersonPorts, state: PersonState, event: FormCreated) {
  if (!claim(state.seen, event.id)) return []
  const form = event.data.form
  if (kindOf(form) === QUESTION_FORM) return []
  if (!state.forms.settled.has(form.id)) setBounded(state.shown, form.id, { sessionID: form.sessionID, title: form.title }, SEEN_MAX)
  const chain = await lineage(ports.storage, form.sessionID)
  // As with a permission request, claimed after the lookup, so a form settled meanwhile is not told.
  if (!chain.length || state.forms.settled.has(form.id) || state.forms.told.has(form.id)) return []
  const startedBy = chain.length > 1 ? chain[0]!.parentID : undefined
  const kind = kindOf(form)
  const telling = ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(form.sessionID, formNotice(chain[0]!.title, form, startedBy, nativeRootOf(chain), topOf(chain)), {
      asks: "form",
      form: form.id,
      ...(kind ? { kind } : {}),
    }),
    description: `Session ${form.sessionID} shows a form`,
    metadata: { source: "courier", from: form.sessionID, asks: "form", formID: form.id, ...(kind ? { kind } : {}) },
    delivery: "steer",
  })
  setBounded(state.forms.told, form.id, telling, SEEN_MAX)
  await telling
  return [topOf(chain)]
}

/** Tells the session told about a form that it was answered or withdrawn, so it does not send the person to a form that is gone. */
export async function reportFormSettled(ports: PersonPorts, state: PersonState, event: FormSettled) {
  if (!claim(state.seen, event.id)) return []
  const { id, sessionID } = event.data
  state.shown.delete(id)
  const telling = state.forms.told.get(id)
  if (!telling) {
    claim(state.forms.settled, id)
    return []
  }
  state.forms.told.delete(id)
  const settled = event.type === "form.replied" ? "answered" : "cancelled"
  // After the notice that the form is shown, which another instance may still be sending, so the
  // settling never arrives first; and not at all when that notice did not go out.
  const [chain, told] = await Promise.all([lineage(ports.storage, sessionID), telling.then(() => true, () => false)])
  if (!chain.length || !told) return []
  await ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(sessionID, formSettledNotice(chain[0]!.title, id, settled), { settled, form: id }),
    description: `Session ${sessionID} no longer shows a form`,
    metadata: { source: "courier", from: sessionID, settled, formID: id },
    delivery: "steer",
  })
  return [topOf(chain)]
}

/** The forms a session shows now, oldest first, as the tree's `forms` port lists them. */
export const formsShown = (shown: FormsShown, sessionID: string): ShownForm[] =>
  [...shown].flatMap(([id, form]) => (form.sessionID === sessionID ? [{ id, title: form.title }] : []))
