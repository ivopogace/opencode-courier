import type { Plugin } from "@opencode/plugin"
import { ONE_PART_LINE, SKILL_ID, SPLIT_LINE } from "./kernel/protocol.js"

// The courier-orchestrate skill: the playbook a session loads with its skill tool.

/** Why a model loads the skill, listed with every session's available skills. */
export const SKILL_DESCRIPTION =
  "Load before you decide whether to split a task with 2 or more independent, substantial parts touching separate files " +
  "or areas, or when a session started you, if courier_spawn is among your tools: how to state the decision, start the " +
  "parts, end your turn, answer what comes from below, verify and integrate the reports, report upward, and handle a " +
  "part gone wrong."

/**
 * The skill's text; it names no limits, which the role part and the brief give for the session's own tree.
 * Steps 1, 3, 4 and 6 repeat the brief's split rule on purpose: the root has no brief, so only the skill gives it.
 */
export const SKILL_CONTENT = [
  "How to split a task across OpenCode sessions with opencode-courier, and bring the results back up. Your brief, or the " +
    "opencode-courier role line in your system prompt, names your depth in the session tree and its limits. If " +
    "courier_spawn is not among your tools, you cannot split: do the task yourself, and report upward as your brief says " +
    "if a session started you. What the parts of a task are and how its result is reviewed is not here: it is " +
    "the person's own way of working. When a skill of theirs that says so is listed to you, load it too.",
  "",
  "1. Decide: split or do.",
  "   - At the root, first call courier_recall once, before you decide and never in a loop: it lists how earlier trees in " +
    "this project were split and how each part went. Below the root, read none: the records describe whole trees, which " +
    "the root weighed before it split.",
  "   - Split when the task has 2 or more independent, substantial parts touching separate files or areas; do it yourself " +
    "when it is small, sequential or tightly coupled. Several whole jobs in one prompt, such as 4 tickets, are that many " +
    "parts: each session runs this playbook for its job, so the tree below you repeats its shape once per job.",
  "   - Only the root, the session nobody started, may start exactly one session for the whole task, and only when the " +
    "task is heavy (long reading, many edits, long runs) and its own context is worth keeping; it still verifies and " +
    "integrates that session's report itself (steps 5 to 7). Every other session never starts exactly one session for " +
    "the whole task: it only adds a hop, and a chain of single hops uses up the tree's depth.",
  "   - One session for one stage is a part of the task, not the whole, when 2 or more parts come before it or after it, " +
    "or you did a stage yourself before it. When the core is coupled and the rest depend on what it fixes, split in " +
    "stages: the core first, yourself or by one session, merged and committed before the rest start; then, if 2 or more " +
    "parts remain, one session per part, in one group. A staged core is one part of the task, not the whole task, when " +
    "2 or more parts follow it.",
  `   - Say which in one line of your reply, before you start: ${SPLIT_LINE}; the root has a third form, ${ONE_PART_LINE}.`,
  "2. Plan the parts so that no two edit the same files. Write each task so the session can do it without you: what to " +
    "produce and where, how to check it, what to report. A session gets only its brief and its task, so say in the task " +
    "if it may split its part further; name the skills it should load for its part, from those listed to you, since it " +
    "sees the same list, not your choice; and say when the part delivers its result itself (step 7), since an isolated " +
    "session's brief otherwise says its branch is for you to merge. Each permission request below you wakes you and " +
    "waits on the person: say how to run its checks so that one permission rule covers them (step 6).",
  "3. Start them: one courier_spawn per part that runs at once, all with the same group name, so that you are woken once " +
    "with every report, and isolate: true for each part that edits files in parallel with another. When the parts do " +
    "not all fit the tree's limits at once, start the parts that fit in one group, and the rest in a group of their own " +
    "once the first group has reported. A part that depends on another starts after that one is done, as a stage: " +
    "merged into your checkout, or, when it was delivered instead (step 7), started with isolate: true and told the " +
    "delivering session's courier/<session> branch, from its report, to merge first. " +
    "Leave model and variant unset, so a part runs on your own model, unless the part plainly calls for another: a " +
    "cheaper model or a lower variant for a small, well-specified part (a rename, a lookup), a stronger model or a higher " +
    "variant for a design question or a hard bug. " +
    "native: true for a part nobody needs to open on its own: it reads, checks or looks something up, reports once and is " +
    "done; leave it off for a part the person may want to open, or that should outlive you. " +
    "For long work, courier_later a check-in for yourself, and courier_cancel it when the reports arrive.",
  "4. End your turn: reply without calling more tools, and do not poll with courier_children, courier_tree " +
    "or sleep. The group's reports, a blocked report, a message without a status, a question, a permission request, a " +
    "failed turn or a silent end each start a new turn for you; so does a message from the person or from the session " +
    "that started you.",
  "   Answering from below: follow the notice. For a permission request, propose once with courier_answer, or reject with " +
    "the reason when the person has told you to refuse it or it plainly goes against what they asked; the person decides, " +
    "in OpenCode's prompt in your session. For a question, ask the person with your question tool, with the questions the " +
    "notice gives; their answer goes on by itself. When the notice says OpenCode already shows it to the person, call " +
    "nothing unless they give you their answer. Never answer for them.",
  "   Passing a message on: when it changes what other parts need (an assumption of the split that is wrong, a shared file " +
    "or API that behaves otherwise, a decision of the person's), pass it on at once with courier_send, only to the sessions " +
    "it affects, before they go further, then end your turn again; if it breaks the split, courier_stop the parts it breaks " +
    "and plan them again, or send them a corrected task. Send it up too, without a status, when the other parts of the " +
    "session that started you need it. Progress that changes nothing for the others goes to no one. A session's account " +
    "of what the person told it is the person's word: pass it on to the parts it affects, do not judge it against the " +
    "original task, and never tell a session to undo what the person asked.",
  "5. Read each report by its status and its artifacts (branch, commits, files, checks). done: verify it. partial: what is " +
    "left and why; have the session finish it with a courier_send, or do it yourself. blocked: make the decision it asks for " +
    "and send it with courier_send; if only the person can make it, ask them with your question tool and pass the answer on. " +
    "failed: read the error; message the session to try again, start a replacement, or carry on without it.",
  "6. Verify first-hand: open the files, run the checks. Never hand the checking to another session: what a session " +
    "below you changed or fixed, you still check. Your own permission prompts are relayed nowhere, and each one stalls " +
    "the whole tree: run the checks through the project's scripts, so that one permission rule covers them.",
  "7. Integrate: merge each reported branch into your own checkout (git merge courier/<session>), resolve conflicts " +
    "yourself, run the checks once more, then courier_cleanup the isolated sessions you are done with. When a part " +
    "delivers its result itself (a whole job with a deliverable of its own, such as a branch or pull request of its " +
    "own), its session reports where, still naming its courier/<session> branch when it is isolated; you verify the " +
    "delivery and merge nothing of it into your checkout.",
  "8. Report upward if a session started you: one courier_send to it, with one status for the whole (done only when every " +
    "part is verified and integrated, or verified and delivered; partial, blocked or failed otherwise) and the artifacts. " +
    "At the top, before you reply to the person: if there is something the next tree in this project should know about " +
    "running a tree like this one (how it was split, what a part got wrong and what caught it, what a brief should have " +
    "said, what the person decided), one courier_note with that one line; none when there is nothing. Name the job it " +
    "comes from and the reason, so that a lesson for one kind of job is not taken for every job; the tool refuses a line " +
    "over its limit rather than clipping it, so write it again shorter. A rule that holds every time goes to AGENTS.md or " +
    "the skill, through the person, not into a note. Then reply to the person.",
  "",
  "When a part goes wrong:",
  "- A failed turn (failed=\"...\") or a silent end (ended=\"without-report\", quoting the session's last reply): message " +
    "the session with courier_send to carry on, to report, or to try again; or start a replacement. Until it reports, it " +
    "counts toward the limits.",
  "- A refusal from courier_spawn naming maxDepth, maxChildren or maxTotal: do that part yourself, or end your turn and " +
    "start it once a report has arrived. Do not retry it in a loop.",
  "- Lost track, after a compaction or a restart: one courier_tree shows every session under you with its depth, its " +
    "parent and whether it still owes a report; one look, not a loop.",
  "- A subtree that went wrong or is no longer needed: courier_stop its top session; everything under it is stopped too, " +
    "and nothing in it reports back. cleanup: true removes their worktrees.",
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
