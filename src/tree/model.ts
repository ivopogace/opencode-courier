import { modelName, parseModelName, type ModelRef } from "./domain.js"
import type { CourierPorts, KnownModel } from "./ports.js"
import { modelFormatRefusal, unknownModelRefusal, unknownVariantRefusal, variantWithoutModelRefusal } from "./text.js"

/** What courier_spawn says of the model: `provider/model`, and the variant of whichever model is chosen. */
export interface ModelChoice {
  readonly model?: string
  readonly variant?: string
}

/**
 * The model a child runs on: the `model` named, else the agent's, else the one its parent runs on, with the `variant`
 * named; `parent` is the parent's own, for the roster to tell a child on another one.
 */
export async function chooseModel(ports: CourierPorts, parentID: string, choice: ModelChoice, agent: string | undefined) {
  // Some models send null, or an empty string, for an optional field they leave out.
  const named = trimmed(choice.model)
  const variant = trimmed(choice.variant)
  const own = named === undefined ? undefined : parseModelName(named)
  if (named !== undefined && !own) throw new Error(modelFormatRefusal(named))
  const parent = await parentModel(ports, parentID)
  const inherited = own ? undefined : await inheritedModel(ports, parent, agent).catch(() => parent)
  const base: ModelRef | undefined = own ?? inherited
  if (!base) {
    if (variant !== undefined) throw new Error(variantWithoutModelRefusal(variant))
    return { model: undefined, parent }
  }
  const chosen = variant ?? base.variant
  const model: ModelRef = { providerID: base.providerID, id: base.id, ...(chosen !== undefined ? { variant: chosen } : {}) }
  if (own || variant !== undefined) await check(ports, model, own !== undefined)
  return { model, parent }
}

/**
 * The model the parent runs on: its session's, else OpenCode's default. A failed lookup must not keep a child on no
 * particular model from starting, so it reads as none, and the child then runs on OpenCode's default.
 */
async function parentModel(ports: CourierPorts, parentID: string): Promise<ModelRef | undefined> {
  const session = await ports.session.get({ sessionID: parentID }).catch(() => undefined)
  if (!session) return undefined
  return session.model ?? (await ports.defaultModel().catch(() => undefined))
}

/** The named agent's model, if it names one; else the parent's. */
async function inheritedModel(ports: CourierPorts, parent: ModelRef | undefined, agent: string | undefined) {
  if (!agent) return parent
  const named = await ports.agent.get({ agentID: agent, location: { directory: ports.directory } })
  return named.data.model ?? parent
}

/**
 * Refuses a model OpenCode does not list, or a variant its model has not; `"default"` is every model's. A listing that
 * cannot be read checks nothing: OpenCode refuses what it does not know at the child's first turn, which is reported.
 */
async function check(ports: CourierPorts, model: ModelRef, named: boolean) {
  let known: ReadonlyArray<KnownModel>
  try {
    known = await ports.models()
  } catch (error) {
    ports.log(`courier_spawn: cannot list the models to check ${modelName(model)} against: ${String(error)}`)
    return
  }
  const found = known.find((item) => item.providerID === model.providerID && item.id === model.id)
  if (!found) throw new Error(unknownModelRefusal(model, known, named))
  if (model.variant !== undefined && model.variant !== "default" && !found.variants.includes(model.variant))
    throw new Error(unknownVariantRefusal(model, found.variants))
}

const trimmed = (value: string | undefined) => (typeof value === "string" ? value.trim() || undefined : (value ?? undefined))
