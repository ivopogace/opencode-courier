import type { Plugin } from "@opencode/plugin"
import { SKILL_ID } from "./kernel/protocol.js"

export const SKILL_DESCRIPTION =
  "How opencode-courier's session tools work. Load it when you are asked to start sessions with courier_spawn: " +
  "writing a session's task, waiting without polling, permission requests and questions from below, reports, " +
  "merging an isolated session's branch."

export const SKILL_CONTENT = [
  "# How opencode-courier's session tools work",
  "",
  "Whether to start sessions, how many and for what comes from the person, their skills or your task, not from this skill.",
  "",
  "## 1. Start a session",
  "",
  "- When the sessions asked for do not all fit the tree's limits at once, start the next as each report " +
    "frees a slot; a blocked session keeps its slot.",
  "- Sessions work in your directory, on the same files, unless started with isolate: true.",
  "- A session sees none of your conversation: its task has to say what to produce and where, the context it " +
    "needs, how to check it, and what to report. Name the skills it should load, from those listed to you (an " +
    "isolated session sees only committed project skills).",
  "",
  "## 2. End your turn",
  "",
  "- Reply without calling more tools; reports and notices wake you. After one, while sessions are still out, end your " +
    "turn again.",
  "- At the root, a permission request or question from below arrives with its own instructions: follow them, and never " +
    "answer for the person.",
  "- When a message changes what other sessions need (a wrong assumption in their tasks, a shared file or API that behaves " +
    "otherwise, a decision of the person's), courier_send it at once, only to the sessions it affects, and, below " +
    "the root, also to the session that started you when it reaches past your task, as your brief says; a session " +
    "whose task no longer holds can be stopped with courier_stop or sent a corrected task. Text typed into a session under you arrives from " +
    "courier in a route=\"prompt\" envelope that every session above you also has: pass it only to the sessions you " +
    "started that it changes, as the envelope says, and say that it arrived over the prompt route, so it is not read " +
    "as your own instruction.",
  "",
  "## 3. Reports",
  "",
  "A report is the session's own claim: courier does not check it, so check it before you rely on it. A blocked " +
    "report: make the decision it asks for and send it with courier_send; if only the person can make it, ask them " +
    "with your question tool and pass the answer on. A session that reported partial or failed takes its task up " +
    "again when you courier_send it.",
  "",
  "## 4. Branches and cleanup",
  "",
  "An isolated session commits on the branch it reports: git merge courier/<session> brings it into your checkout. " +
    "courier_cleanup removes a session you are done with, isolated or not.",
].join("\n")

export type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

const SKILL_PATH = `skill://${SKILL_ID}/SKILL.md`

export const orchestrateSkill = () =>
  ({ id: SKILL_ID, name: SKILL_ID, description: SKILL_DESCRIPTION, path: SKILL_PATH, content: SKILL_CONTENT }) as const

export function addSkill(skills: SkillEditor) {
  skills.add(orchestrateSkill() as Parameters<SkillEditor["add"]>[0])
}
