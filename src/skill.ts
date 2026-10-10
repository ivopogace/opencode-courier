import type { Plugin } from "@opencode/plugin"
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_ID } from "./notices.js"

/** The editor OpenCode hands a skill transform. */
export type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

/** A skill's path is where OpenCode would look for its files; this one has none, so a path of the plugin's own. */
const SKILL_PATH = `/opencode-courier/${SKILL_ID}.md`

/** The courier-orchestrate skill as OpenCode lists it: its id, name and description, and the text the model loads. */
export const orchestrateSkill = () =>
  ({ id: SKILL_ID, name: SKILL_ID, description: SKILL_DESCRIPTION, path: SKILL_PATH, content: SKILL_CONTENT }) as const

/** Adds the courier-orchestrate skill; every instance adds the same one, under the same id. */
export function addSkill(skills: SkillEditor) {
  skills.add(orchestrateSkill() as Parameters<SkillEditor["add"]>[0])
}
