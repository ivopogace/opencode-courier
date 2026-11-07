# Comprehension Report

**Target:** `egm-review/courier-orchestrate.SKILL.md` (`lines 1-51`, full file; no implementation plan, so FeatureRange is the whole document)
**Stage:** 6, Comprehension Test. Reviewer: `egm-comprehension`, status completed (direct dispatch). This is the reviewer's complete result. It read the target and its persona, and the tool-description section of `test/__snapshots__/notices.test.ts.snap` only to confirm whether an undefined term is defined in a tool description the reader also sees; it did not use the plugin's source or docs. Line numbers are those of the rendered file; `line_map.tsv` maps them to `src/skill.ts`.

## What this proposes

This text is the run-time instruction set an OpenCode session loads before it splits a task across child sessions with the courier tools. It prescribes a six-step loop: decide whether to split and declare the decision in one fixed-form line; spawn the parts in one named group, isolated when they edit files; end the turn and let reports wake you instead of polling, relaying permissions, questions and cross-part news as they arrive; verify every report first-hand; merge the parts' branches; and report upward with one status, leaving a one-line lesson via courier_note at the top. A closing section covers failed turns, limit refusals, lost state after compaction, and stopping subtrees.

## How the existing system works, per this document

Sessions form a tree. The root is the session the person started; every other session was started by a parent with courier_spawn and carries a "brief" that names its depth, the tree's limits, and how to report. Children report to their parent with courier_send carrying a status (done, partial, blocked, failed); reports in a group are held and delivered together, and each delivery, question, permission request, failed turn or silent end starts a new turn for the parent. Isolated children work in their own git worktree on a courier/<session> branch the parent merges; some parts are "whole jobs" that deliver their own result and are not merged. Permission requests and questions from below reach the parent as "notices", which the parent relays to the person via courier_answer or its question tool; the person decides. maxDepth, maxChildren and maxTotal cap the tree, and courier_recall / courier_note form a per-project memory of earlier trees.

No section was unparaphrasable, so no Blocker on that ground. The paraphrase above is the reviewer's reading; where it is wrong, that is itself a finding.

## Findings

1. **Major. Lines 7, 15, 21.** "brief" and "role line" are never defined. The reader is told to obey what "your brief says" (7, 15) and, at 21, that "an isolated session's brief otherwise says its branch is for you to merge", but the parent never sees the brief its child gets, so it cannot know what the brief "otherwise says" or what to override. Not defined in any tool description; the closest is courier_spawn's task field ("It is told who started it and how to report back"). One clause would do: the brief is the text courier_spawn puts before your task.

2. **Major. Lines 21, 23, 39.** "whole job that delivers itself" / "a whole job with a deliverable of its own" is defined only by consequence ("its session delivers it and reports where", 39). What "delivers" means (push to a remote, open a PR, write somewhere) is never said, so the reader cannot tell when a part qualifies or what to instruct. Lines 23 and 39 also pull against each other: 39 says you "merge nothing of it into your checkout", while 23 tells a dependent sibling to "merge the delivering session's courier/<session> branch first". A reader cannot reconcile a result that is delivered elsewhere and must not be merged with one that lives on a courier branch a sibling must merge.

3. **Major. Lines 27, 30.** "A message without a status" is listed at 27 as something that wakes you, and 30 says to "send it up too, without a status" when the parent's other parts need it, then "Progress goes to no one." The courier_send description (confirmed) says "without one, a message to the session that started you is progress, not your report". So, with the tool text the reader also has, a status-less message both is progress and is the vehicle for the one thing that is not progress. The document never separates the two cases.

4. **Major. Lines 27, 29, 34.** "a blocked report" and "a question" are listed as different events, and each gets a different handling path (34: courier_send the decision; 29: question tool, then the answer "goes on by itself" or courier_answer per the tool description). The document never says what distinguishes a child's question from a child's blocked report, so the reader cannot tell which path applies when a child needs a decision. The courier_answer description (confirmed) ties "question" to a requestID from a notice, which is the missing distinction.

5. **Major. Lines 29, 48.** "notice" is used as the authority ("follow the notice"; "When the notice says OpenCode already shows it to the person, call nothing") without saying what a notice is, where it appears, or what it can say. The courier_answer description (confirmed) also says "after a notice from it named the request" but does not define it either. "Follow the notice" delegates the rule to run-time text the reader has not seen; at minimum say that a notice is the message that wakes you and that it names the request id and session.

6. **Major. Lines 21, 35.** "one permission rule covers the checks", "one permission rule for skill covers their loads", and "through the project's scripts rather than a tool's own path" assume the reader knows OpenCode's permission-rule model and what "a tool's own path" means. The intent (run checks via package scripts so a single allow rule matches, rather than invoking binaries directly) is guessable but not stated; "a tool's own path" is vague.

7. **Major. Line 22.** "native: true for a part that only reads ... leave it off for a part the person may want to open, or that should outlive you." The rationale depends on knowing what native does (confirmed in courier_spawn's native description: an OpenCode subagent, hidden from session lists, deleted with its parent, refused with isolate). The document claims at line 9 that it "says how the tools behave" yet gives none of this; without the tool text the heuristic is unmotivated, and the isolate/native exclusivity is never mentioned.

8. **Nit. Lines 7, 20, 48, 49.** "limits" / "the tree's limits" are used at 7, 20 and 48 but only named (maxDepth, maxChildren, maxTotal) at 49, and never glossed. Line 20 ("do not all fit the tree's limits at once") needs the reader to know which limit counts running sessions versus total; line 48 ("counts toward the limits") likewise. The names appear in courier_tree's description and in refusal text, but the meaning of each is in the brief, which this document says names them (7), so the gap is partly covered. A parenthetical at 7 or 20 would close it.

9. **Nit. Line 20.** "group" is explained only by effect ("so that you are woken once with every report"). Confirmed defined in courier_spawn's group description (join group, held reports; blocked/question/permission/failed still arrive at once). Acceptable, but the document's own statement at 27 that a blocked report wakes you separately is the only place the exception surfaces here.

10. **Nit. Line 20.** "isolate: true" is used without saying it means a separate git worktree and a courier/<session> branch; confirmed in the isolate description. The document's line 39 merge command makes it inferable. The isolate description also warns that from an isolated session the child starts from your last commit, not uncommitted changes; the skill omits this prerequisite, which matters for step 2 and line 23.

11. **Nit. Lines 27, 30, 34, 43.** "status" is used from 27 onward; the four values appear only at 34, and the document never says a status is an attribute of courier_send. Confirmed in the courier_send description, so covered for the reader.

12. **Nit. Lines 15, 44, 51.** "the root" is defined at 15 ("the session nobody started"). "the top" is used at 44 to mean the root and at 51 ("its top session") to mean the highest session of a subtree; two meanings of one word. "the person" is never defined; inferable as the human user, but the document also uses "the person" for someone who may type into a child session (30), which is a second role.

13. **Nit. Line 9.** "is a playbook's: if a skill for that is listed to you, load it too" does not name or describe the skill, so the reader cannot tell which listed skill is meant.

14. **Nit. Line 16.** The three forms of the decision line mix literal text and placeholders ("…", "<n>", "<the parts you weighed>") without saying which is which; "before you start" is clear enough given 13.

15. **Nit. Line 23.** Sentence structure: "started with isolate: true and told to merge the delivering session's courier/<session> branch first" reads as describing the delivered part rather than the dependent one. Also depends on finding 2.

16. **Nit. Line 48.** `failed="..."` and `ended="without-report"` are attribute names from a message envelope the document never introduces; the reader learns of the envelope only on seeing one. Recognisable at run time, so Nit.

17. **Nit. Line 35.** "Your own permission prompts are relayed nowhere, and each one stalls the whole tree, as each request below you waits on the person" states the effect without the mechanism (while you sit on a prompt you cannot relay the requests below you). A reader may not see why their own prompt stalls others.

18. **Nit. Line 30.** "Send it up too ... when your parent's other parts need it" asks for a judgment the session cannot make: it does not know its parent's other parts. Consider "when it may concern work outside your part".

19. **Nit. Lines 7 vs 49.** Two mechanisms for "cannot split": courier_spawn absent from your tools (7) and courier_spawn present but refusing with maxDepth (49). Not contradictory, but the reader cannot tell which to expect at a leaf.

20. **Nit. Line 44.** "the tool refuses a line over its limit" without the limit; confirmed in courier_note's description (300 characters), so covered.

21. **Nit. Section heading "## 3. End your turn" (25)** holds the relaying rules (29-30), which are about what to do in the next turn, not about ending this one. A reader scanning headings will not find the relay rules.

Terms on the caller's list the reviewer did not flag: "compaction" (general agent-tooling term, line 50), "courier/<session> branch" (merge command given at 39, and confirmed in the isolate description), "part" (defined by use at 14 and 15), "standing" (does not occur in the document). "the split line" also does not occur as a term; the document says "one line of your reply" (16).

## Severity counts

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 7 |
| Nit | 14 |
