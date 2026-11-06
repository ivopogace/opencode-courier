import { modelName, parseModelName, type ModelRef } from "./domain.js"
import type { CourierPorts, KnownModel } from "./ports.js"
import { modelFormatRefusal, unknownModelRefusal, unknownVariantRefusal, variantWithoutModelRefusal } from "./text.js"

export interface ModelChoice {
  readonly model?: string
  readonly variant?: string
}

export async function chooseModel(ports: CourierPorts, parentID: string, choice: ModelChoice, agent: string | undefined) {
  const named = trimmed(choice.model)
  const variant = trimmed(choice.variant)
  const own = named === undefined ? undefined : parseModelName(named)
  if (named !== undefined && !own) throw new Error(modelFormatRefusal(named))
  const parent = await parentModel(ports, parentID)
  // with no model passed, OpenCode applies the agent's own (api-notes)
  const inherited = own ? undefined : await inheritedModel(ports, parent, agent).catch(() => undefined)
  const base: ModelRef | undefined = own ?? inherited
  if (!base) {
    if (variant !== undefined) throw new Error(variantWithoutModelRefusal(variant, agent))
    return { model: undefined, parent }
  }
  const chosen = variant ?? base.variant
  const model: ModelRef = { providerID: base.providerID, id: base.id, ...(chosen !== undefined ? { variant: chosen } : {}) }
  if (own || variant !== undefined) await check(ports, model, own !== undefined)
  return { model, parent }
}

async function parentModel(ports: CourierPorts, parentID: string): Promise<ModelRef | undefined> {
  const session = await ports.session.get({ sessionID: parentID }).catch(() => undefined)
  if (!session) return undefined
  return session.model ?? (await ports.defaultModel().catch(() => undefined))
}

async function inheritedModel(ports: CourierPorts, parent: ModelRef | undefined, agent: string | undefined) {
  if (!agent) return parent
  const named = await ports.agent.get({ agentID: agent, location: { directory: ports.directory } })
  return named.data.model ?? parent
}

// OpenCode refuses an unknown model at the child's first turn (api-notes)
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
