---
name: courier-playbook
description: Load with courier-orchestrate when you split a task across OpenCode sessions. How to choose the parts, write their tasks, stage a tightly coupled core, review the merged result, and fit many parts in the tree's limits.
---

# Planning and reviewing a split

courier-orchestrate says how the tools behave; this playbook says how to shape the work. Load both.

## The parts a task can have

Besides its edits, each one session where it is worth a context of its own:

- a scout: a session with isolate: false reads the code, or a library's or a host's source, tries things and reports what it found, before you plan;
- the implementers, isolate: true where two edit at once, each with its checks and what to report;
- its e2e scenario, its documentation, sometimes a second test file;
- a review stage after the merge (below).

Several whole jobs in one prompt, such as 4 tickets, are that many parts: each session runs this playbook for its job, stages, review and all, so the tree below you repeats its shape once per job.

Do it yourself, or start one scout first, when you do not know yet what is wrong.

## When the core is coupled

A task with one tightly coupled core usually still has parts from that list; weigh each. When the rest depend on names and texts the core fixes, split in stages: the core first, yourself when it is small or by one session when it is big, merged and committed before the rest start; then, if 2 or more parts remain, one session per part, in one group. A staged core is one part of the task, not the whole task, when 2 or more parts follow it.

## Writing a task

- Scope: what to produce and where, and what it must not touch.
- Context: the error messages, paths, names and decisions it needs, pasted in.
- Checks: the project's script to run.
- Report: what it found, what it changed, its commits and the checks it ran.

A task that works:

> Make the 3 failing tests in test/abort.test.ts pass: "keeps partial output", "completes the fast tool" and "counts pending tools". They look like timing issues: find the real cause and replace fixed sleeps with waiting on the event; fix src/abort.ts if the bug is there. Touch no other test file and raise no timeout. Check with bun run test. Report the cause of each failure, what you changed, your commits and the check's result.

## The review stage

After the merge, a review stage sees the whole: one review session with fresh context, which fixes nothing itself. Put in its task the diff to read: your checkout's HEAD, merges committed, against the commit you noted before your first spawn; when you are isolated, your courier/<session> branch, committed first, against your worktree's start.

- It may hand the reading to 2 or more reviewers in one group, each from one angle, then starts one verifier with their reports, which drops the findings that do not hold and starts one implementor for what holds (2 or more with isolate: true when the fixes are independent, merged after). An implementor refuses, with the reason, what it should not fix.
- In the project's checkout, the review session, the verifier and a lone implementor go without isolate and commit in place; when you are isolated, each gets isolate: true, so each worktree starts from the one above. Reviewers only read.
- It reports what was found, held, fixed (the commits) and refused, and why. It does not replace your own verification: running the checks on the fixed tree stays yours, and so does settling a refusal you disagree with.
- Plan, start, verify and merge the stage like any other parts, or do its work yourself when the levels below you are too few. One session for one stage, after a stage of 2 or more parts or one you did yourself, is a part of the task, not the whole; a reviewer alone with nothing before it is not a stage.

## Many parts

When each part runs a review stage of its own, count 6 live sessions per part against maxTotal (a part, its review session and its reviewers at the peak): start the parts that fit in one group, and the rest in a group of their own once the first group has reported.

## Common mistakes

- Too vague: "fix the tests". Instead: name the files, paste the errors, say what to report.
- Two parts in one file, or in parallel without isolate: true. Instead: separate files, isolate: true.
- courier_children or sleep after spawning. Instead: end your turn; the reports wake you.
- Taking a done report on its word. Instead: open the files and run the checks yourself.
- Answering a question or a permission request for the person. Instead: ask them, or propose and let them decide.
