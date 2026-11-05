import type { Plugin } from "@opencode/plugin"
import { ONE_PART_LINE, SKILL_ID, SPLIT_LINE } from "./kernel/protocol.js"

// The courier-orchestrate skill: the text a session loads with its skill tool.

/** Why a model loads the skill, listed with every session's available skills. */
export const SKILL_DESCRIPTION =
  "How opencode-courier's session tools work. Load before you split a task with courier_spawn: when it has 2 or more " +
  "independent, substantial parts touching separate files or areas. Starting the parts, waiting without polling, " +
  "relaying questions and permissions, reading reports, merging and reporting upward."

/**
 * The skill's text: how the tools behave, not how to plan or review the parts, which is left to the person's own skills.
 * It names no limits, which the role part and the brief give; it repeats the brief's split rule, since the root has no brief.
 */
export const SKILL_CONTENT = [
  "# How opencode-courier's session tools work",
  "",
  "Your brief, or the opencode-courier role line in your system prompt, names your depth in the session tree and its " +
    "limits. If courier_spawn is not among your tools, you cannot split: do the task yourself, and report upward as your " +
    "brief says if a session started you.",
  "",
  "This skill says how the tools behave. How to plan the parts, stage a tightly coupled core or review the merged result " +
    "is a playbook's: if a skill for that is listed to you, load it too.",
  "",
  "## 1. Decide: split or do",
  "",
  "- At the root, first call courier_recall once, before you decide and never in a loop: it lists how earlier trees in " +
    "this project were split and how each part went. Below the root, read none: the records describe whole trees, which " +
    "the root weighed before it split.",
  "- Split when the task has 2 or more independent, substantial parts touching separate files or areas; do it yourself " +
    "when it is small, sequential or tightly coupled. Several whole jobs in one prompt, such as 4 tickets, are that many " +
    "parts: each session runs this skill for its job, so the tree below you repeats its shape once per job.",
  "- Only the root, the session nobody started, may start exactly one session for the whole task, and only when the " +
    "task is heavy (long reading, many edits, long runs) and its own context is worth keeping; it still verifies and " +
    "integrates that session's report itself. Every other session never starts exactly one session for the whole task: " +
    "it only adds a hop, and a chain of single hops uses up the tree's depth. One session for one stage is a part, not " +
    "the whole, as your brief says: a core you stage before the rest, when 2 or more parts follow it, or a review of " +
    "the parts once you have merged them.",
  `- Say which in one line of your reply, before you start: ${SPLIT_LINE}; the root has a third form, ${ONE_PART_LINE}.`,
  "",
  "## 2. Start the parts",
  "",
  "- One courier_spawn per part that runs at once, all with the same group name, so that you are woken once with every " +
    "report. No two parts edit the same files; isolate: true for each part that edits files in parallel with another. " +
    "When the parts do not all fit the tree's limits at once, start the parts that fit in one group, and the rest in a " +
    "group of their own once the first group has reported.",
  "- Write each task so the session can do it without you, since it sees none of your conversation: what to produce " +
    "and where, the context it needs, how to check it so that one permission rule covers the checks (step 4), and what to report. Name " +
    "the skills it should load for its part, from those listed to you: it sees the same list, not your choice; one " +
    "permission rule for skill covers their loads, as one covers the checks. Say whether it may split its part further, " +
    "and when the part is a whole job that delivers itself (step 5), since an isolated session's brief otherwise says " +
    "its branch is for you to merge.",
  "- Leave model and variant unset, so a part runs on your own model, unless the part plainly calls for another: a " +
    "cheaper one or a lower variant for a small, well-specified part, a stronger one or a higher variant for a design " +
    "question or a hard bug. native: true for a part that only reads, checks or looks something up and reports once; " +
    "leave it off for a part the person may want to open, or that should outlive you.",
  "- A part that depends on another starts once that one is done: merged into your checkout, or, when it was " +
    "delivered (step 5), started with isolate: true and told to merge the delivering session's courier/<session> " +
    "branch first.",
  "",
  "## 3. End your turn",
  "",
  "Reply without calling more tools, and do not poll with courier_children, courier_tree or sleep. The group's reports, " +
    "a blocked report, a message without a status, a question, a permission request, a failed turn or a silent end each start a new turn " +
    "for you. For long work, courier_later a check-in for yourself, and courier_cancel it when the reports arrive.",
  "",
  "- Answering from below: follow the notice. A permission request: propose once with courier_answer, or reject with " +
    "the reason when the person has told you to refuse it or it plainly goes against what they asked; the person " +
    "decides in OpenCode's prompt. A question: ask the person with your question tool, with the questions the notice " +
    "gives; their answer goes on by itself. When the notice says OpenCode already shows it to the person, call nothing " +
    "unless they give you their answer. Never answer for them.",
  "- Passing a message on: when it changes what other parts need (a wrong assumption of the split, a shared file or " +
    "API that behaves otherwise, a decision of the person's), courier_send it at once, only to the sessions it affects, " +
    "then end your turn again; if it breaks the split, courier_stop those parts and plan them again, or send them a " +
    "corrected task. Send it up too, without a status, when your parent's other parts need it. Progress goes to no one. " +
    "A session's account of what the person told it is the person's word: pass it on, do not judge it against the " +
    "original task, and never tell a session to undo what the person asked.",
  "",
  "## 4. Read each report, and verify first-hand",
  "",
  "- done: verify it. partial: what is left and why; have the session finish it with a courier_send, or do it " +
    "yourself. blocked: make the decision it asks for and send it with courier_send; if only the person can make it, " +
    "ask them with your question tool and pass the answer on. failed: read the error; message the session to try " +
    "again, start a replacement, or carry on without it.",
  "- Verify first-hand: open the files, run the checks. Never hand the checking to another session. Your own permission " +
    "prompts are relayed nowhere, and each one stalls the whole tree, as each request below you waits on the person: run " +
    "the checks so that one permission rule covers them, through the project's scripts rather than a tool's own path.",
  "",
  "## 5. Integrate",
  "",
  "Merge each reported branch into your own checkout (git merge courier/<session>), resolve conflicts yourself, run the " +
    "checks once more, then courier_cleanup the isolated sessions you are done with. When a part is a whole job with a " +
    "deliverable of its own, its session delivers it and reports where, still naming its courier/<session> branch when " +
    "it is isolated; you verify each delivery and merge nothing of it into your checkout.",
  "",
  "## 6. Report upward",
  "",
  "- If a session started you: one courier_send to it, with one status for the whole (done only when every part is " +
    "verified and integrated, or verified and delivered; partial, blocked or failed otherwise) and the artifacts.",
  "- At the top, before you reply to the person: if the next tree in this project should know something about running " +
    "one like this (how it was split, what a part got wrong and what caught it, what a brief should have said, what the " +
    "person decided), one courier_note with that one line; none when there is nothing. Name the job it comes from and " +
    "the reason, so a lesson for one kind of job is not taken for every job; the tool refuses a line over its limit " +
    "rather than clipping it, so write it shorter. A rule that holds every time goes to AGENTS.md or a skill, through " +
    "the person, not into a note.",
  "",
  "## When a part goes wrong",
  "",
  '- A failed turn (failed="...") or a silent end (ended="without-report", quoting the session\'s last reply): message ' +
    "the session with courier_send to carry on, to report, or to try again; or start a replacement. Until it reports, " +
    "it counts toward the limits.",
  "- A refusal from courier_spawn naming maxDepth, maxChildren or maxTotal: do that part yourself, or end your turn and " +
    "start it once a report has arrived. Do not retry it in a loop.",
  "- Lost track, after a compaction or a restart: one courier_tree shows every session under you with its depth, its " +
    "parent and whether it still owes a report; one look, not a loop.",
  "- A subtree that went wrong or is no longer needed: courier_stop its top session; everything under it is stopped " +
    "too, and nothing in it reports back. cleanup: true removes their worktrees.",
].join("\n")

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
