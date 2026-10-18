import type { Plugin } from "@opencode/plugin"
import { SKILL_ID, SPLIT_LINE } from "./kernel/protocol.js"

// The courier-orchestrate skill: the playbook a session loads with its skill tool.

/** Why a model loads the skill, listed with every session's available skills. */
export const SKILL_DESCRIPTION =
  "Load at the start of any implementation task that may have independent parts, or when a session started you, to " +
  "decide whether to split it across OpenCode sessions with courier_spawn and state the decision, and how: plan the " +
  "parts, start them, end your turn, read the reports, verify the work, integrate it and report upward, and what to do " +
  "when a part goes wrong."

/** The skill's text; it names no limits, which the role part and the brief give for the session's own tree. */
export const SKILL_CONTENT = [
  "How to split a task across OpenCode sessions with opencode-courier, and bring the results back up. Your brief, or the " +
    "opencode-courier role line in your system prompt, names your depth in the session tree and its limits.",
  "",
  "1. Decide: split or do. First call courier_recall once: it lists how earlier trees in this project were split and how " +
    "each part went, so weigh that; one call, before you decide, never in a loop. Split when the task has 2 or more " +
    "independent, substantial parts touching separate files or areas; do it yourself when it is small, sequential or tightly coupled. Never start exactly one session for the whole " +
    "task: it only adds a hop. What you read and write yourself stays in your context for every later turn, so keep the " +
    "deciding, checking and integrating, and hand off the long reading and writing. An implementation task with one tightly " +
    "coupled core usually still has independent parts: finding out what the change needs (a session with isolate: false " +
    "reads the code, or a library's or a host's source, tries things and reports what it found), its e2e scenario, its " +
    "documentation, sometimes a second test file, and a review of the core by a session with fresh context, which reads the " +
    "committed diff against the task and the repository's rules and reports its findings (isolate: false, it edits nothing). " +
    "Weigh each of them. When the other parts depend on names and texts the core fixes, split in stages: the core first, " +
    "yourself when it is small or by one session when it is big, merged and committed before the rest start; then, if 2 or " +
    "more parts remain, one session per remaining part, in one group. A part that is itself big and divisible is split again " +
    "by the session that gets it; at the deepest level a session does its part itself. " +
    `Say which in one line of your reply, before you start: ${SPLIT_LINE}, so that a reasoned decision to do it ` +
    "yourself can be told from one never made.",
  "2. Plan the parts so that no two edit the same files. Write each task so the session can do it without you: what to " +
    "produce and where, how to check it, what to report. Say if it may split its part further, and to run its checks " +
    "through the project's scripts (step 6): each permission request of a session below you wakes you and waits on the person.",
  "3. Start them: one courier_spawn per part, all with the same group name, so you are woken once with every report; " +
    "isolate: true for each part that edits files in parallel with another (commit your own work first if you are isolated " +
    "yourself). For long work, courier_later a check-in for yourself, and courier_cancel it when the reports arrive.",
  "4. End your turn: reply without calling more tools. Do not poll with courier_status, courier_children, courier_tree or " +
    "sleep. The group's reports, a blocked report, a question, a permission request, a failed turn or a silent end each start " +
    "a new turn for you.",
  "5. Read each report by its status and its artifacts (branch, commits, files, checks). done: verify it. partial: what is " +
    "left and why; have the session finish it with a courier_send, or do it yourself. blocked: make the decision it asks for " +
    "and send it with courier_send; if only the person can make it, ask them with your question tool and pass the answer on. " +
    "failed: read the error; message the session to try again, start a replacement, or carry on without it.",
  "6. Verify first-hand: open the files, run the checks. Never hand the checking to another session: a review session's " +
    "findings are a report to act on, and running the checks is still yours. Run checks through " +
    "the project's scripts (bun run <script>, npm run <script>), not ./node_modules/.bin/<tool>, so that one permission " +
    "rule covers them: your own permission prompts are relayed nowhere, and each one stalls the whole tree.",
  "7. Integrate: merge each reported branch into your own checkout (git merge courier/<session>), resolve conflicts " +
    "yourself, run the checks once more, then courier_cleanup the isolated sessions you are done with.",
  "8. Report upward if a session started you: one courier_send to it, with one status for the whole (done only when every " +
    "part is verified and integrated; partial, blocked or failed otherwise) and the artifacts. At the top, before you reply " +
    "to the person: if there is something the next tree in this project should know about running a tree like this one (how " +
    "it was split, what a part got wrong and what caught it, what a brief should have said, what the person decided), one " +
    "courier_note with that one line; none when there is nothing. Name the job it comes from and the reason, so that a " +
    "lesson for one kind of job is not taken for every job; the tool refuses a line over its limit rather than clipping " +
    "it, so write it again shorter. A rule that holds every time goes to AGENTS.md or the skill, through the person, not " +
    "into a note. Then reply to the person.",
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
