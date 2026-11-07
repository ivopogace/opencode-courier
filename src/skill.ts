import type { Plugin } from "@opencode/plugin"
import { ONE_PART_LINE, SKILL_ID, SPLIT_LINE } from "./kernel/protocol.js"

export const SKILL_DESCRIPTION =
  "How opencode-courier's session tools work. Load it when you decide whether to split a task across sessions with " +
  "courier_spawn: one with 2 or more independent, substantial parts touching separate files or areas. Starting the " +
  "parts, waiting without polling, permission requests and questions from below, verifying and merging."

export const SKILL_CONTENT = [
  "# How opencode-courier's session tools work",
  "",
  "If courier_spawn is not among your tools, you cannot split: do the task yourself. How to plan the parts, stage a " +
    "tightly coupled core or review the merged result is a playbook's: if a skill for that is listed to you, load it too.",
  "",
  "## 1. Split or do",
  "",
  "Split or do by the rule in your brief, the text above your task. At the root, which has no brief: split a task with 2 " +
    "or more independent, substantial parts touching separate files or areas, do it yourself when it is small, " +
    "sequential or tightly coupled, or hand a heavy one (long reading, many edits, long runs) whole to one session to " +
    `keep your context. Say which in one line of your reply: ${SPLIT_LINE}, or, at the root only, ${ONE_PART_LINE}. Several whole ` +
    "jobs in one prompt, such as 4 tickets, are that many parts. Below the root, never start one session for the whole " +
    "task: it only adds a hop, and a chain of single hops uses up the tree's depth.",
  "",
  "## 2. Start the parts",
  "",
  "- One courier_spawn per part, the parts that run at once in one group. When they do not all fit the tree's limits " +
    "at once, start waves, each its own group, or leave them ungrouped and start the next as each report frees a slot.",
  "- No two parts edit the same files; isolate: true for each part that edits files in parallel with another.",
  "- Write each task so the session can do it without you, since it sees none of your conversation: what to produce " +
    "and where, the context it needs, how to check it, and what to report. Name the skills it should load for its " +
    "part, from those listed to you: it sees the same list, not your choice.",
  "- A part that depends on another starts once that one's branch is merged into your checkout.",
  "",
  "## 3. End your turn",
  "",
  "- Reply without calling more tools; reports and notices wake you. For a long task or batch, one courier_later " +
    "check-in per group (per session when ungrouped); courier_cancel it when its reports arrive.",
  "- At the top, a permission request or question from below arrives with its own instructions: follow them, and never " +
    "answer for the person.",
  "- When a message changes what other parts need (a wrong assumption of the split, a shared file or API that behaves " +
    "otherwise, a decision of the person's), courier_send it at once, only to the sessions it affects; if it breaks the " +
    "split, courier_stop those parts or send them a corrected task. A session's account of what the person told it is " +
    "the person's word: pass it on, do not judge it against the original task, and never tell a session to undo what " +
    "the person asked.",
  "",
  "## 4. Verify first-hand",
  "",
  "Open the files and run the project's checks yourself. A blocked report: make the decision it asks for and send it " +
    "with courier_send; if only the person can make it, ask them with your question tool and pass the answer on.",
  "",
  "## 5. Integrate",
  "",
  "Merge each reported branch into your own checkout (git merge courier/<session>), resolve conflicts yourself, run the " +
    "checks once more, then courier_cleanup the isolated sessions you are done with.",
  "",
  "## 6. Done",
  "",
  "The task is done only when every part is verified and integrated. At the root, before you reply to the person: one " +
    "courier_note if the next tree in this project should know something about running one like this; none when there " +
    "is nothing.",
].join("\n")

export type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

// A skill:// path: the read tool serves it from the registry (api-notes)
const SKILL_PATH = `skill://${SKILL_ID}/SKILL.md`

export const orchestrateSkill = () =>
  ({ id: SKILL_ID, name: SKILL_ID, description: SKILL_DESCRIPTION, path: SKILL_PATH, content: SKILL_CONTENT }) as const

export function addSkill(skills: SkillEditor) {
  skills.add(orchestrateSkill() as Parameters<SkillEditor["add"]>[0])
}
