---
name: orchestrate-dsh-delivery
description: Orchestrate DeepSeek Harness issue and specification delivery from the Gestalt GitHub tracker through isolated implementation, review, CI, and merge. Use by default when the user asks to implement, fix, continue, or land a ticket or specification in this repository, including short requests such as "implement #123" or "continue this spec".
---

# Orchestrate DSH Delivery

Own the delivery graph from the root task. Treat GitHub Issues, pull requests, checks, and official stacks as durable coordination state. Use Codex tasks and subagents as replaceable executors, not as the source of truth.

## Establish authority

1. Read [the tracker contract](../../../docs/agents/issue-tracker.md), [domain routing](../../../docs/agents/domain.md), `CONTEXT-MAP.md`, and the applicable repository instructions and active Agent Notes.
2. Fetch the complete issue or specification, including comments, labels, acceptance criteria, dependencies, and current pull requests. Resolve ambiguous GitHub numbers as the tracker contract requires.
3. Interpret a request to implement, fix, continue, or land the work as authorization to create branches and isolated worktrees, edit files, commit, push, open or update pull requests, respond to review, and merge after required evidence passes. An explicit user limit such as "do not push" or "stop before merge" overrides this default.
4. Keep tag creation, GitHub Releases, registry publication, signing, notarization, deployment, and other release mutations behind explicit per-release approval. Ticket delivery does not authorize them.

Complete this phase when the requested outcome, live ticket graph, mutation authority, and release stop point are explicit.

## Establish the delivery baseline

1. Before the first workspace write, require a clean checkout, fetch `origin/master`, and create and push one remote `codex/feature-<slug>` baseline from its exact SHA. If work already exists in a dirty checkout, stop new writes, preserve the diff, and migrate it into a clean baseline worktree without moving or cleaning the dirty checkout first.
2. Keep planning authority on the baseline: confirmed prototype conclusions, specification, Agent Notes, Context documents, and published tickets must be committed and pushed before implementation dispatch. Local conversation history and uncommitted files are not handoff artifacts.
3. Record the baseline branch and exact remote SHA in every worker handoff. Verify the ticket's accepted requirements and mapped domain sources are readable from that SHA.
4. Keep one baseline per independently releasable feature or fix. Parallel delivery scopes use separate baselines; extract genuinely shared foundations into their own master-bound delivery instead of copying them between baselines.

Complete this phase when the baseline is remotely visible, the planning checkout is clean, and every implementation input is durable at the recorded SHA.

## Build the delivery frontier

1. Decompose only when the source is not already ticketed. Use the Matt specification and ticket skills for product shaping and blocker-first ticket publication; do not rewrite accepted ticket scope during implementation.
2. Order tickets by live dependency state. A ready frontier contains only tickets whose blockers are merged into the delivery baseline or represented by an intentional official PR stack.
3. Keep independent tickets as independent pull requests. Use a stack only for a real code dependency, never merely to gain parallelism.

Complete this phase when every selected ticket has one base, one acceptance source, and a known dependency position.

## Dispatch isolated writers

1. Keep the root task as the sole coordinator and merger. Prefer one Codex Worktree task per ready ticket when task/worktree tools are available. Assign the project `ticket_worker` role when custom agents are available.
2. Give each worker exactly one ticket, one `codex/<issue>-<slug>` branch, one worktree, the verified remote baseline branch and SHA, the acceptance criteria, and the required reporting format. Never let two writers mutate the same worktree.
3. Allow read-heavy exploration, log analysis, and review to run as subagents inside a ticket. Keep one writer for that ticket unless every writer has a disjoint worktree and branch.
4. Route follow-ups and dependency discoveries through the root task. Sibling agents need no direct communication. Record durable cross-ticket facts in the relevant Issue, pull request, Context document, or Agent Note.
5. If task/worktree creation is unavailable, execute tickets sequentially with one writer in the current checkout. Use subagents only for read-only work and report the reduced isolation.

Complete this phase when every ready ticket has one accountable writer and no mutable checkout has multiple owners.

## Supervise asynchronous workers

1. Treat dispatch as a monitored handoff. Register every independent Codex task in one active wait set and keep the root task alive with bounded waits while any selected worker is running. Preserve task cursors and re-wait after unchanged timeouts without narrating them.
2. Let a completion or attention event resume the root task. Read the result, answer worker needs, route follow-up work, and return the task to the wait set until it reaches a terminal state. Continue supervising the other workers in parallel.
3. Require a human blocker to end with `[BLOCKED · Issue #N]`, one concrete requested action, and the evidence that makes it necessary. Surface that request from the root task; never leave the user to discover it in an implementation task.
4. Keep follow-up ownership in the root task. The user need not ask to continue before the root observes completion. Yield only for missing authority or input, or after all selected workers are terminal and their results have been incorporated into the delivery graph.

Complete this phase when every dispatched task's final state has been observed and acted on, and no selected worker remains unwatched.

## Enforce the worker contract

Require each ticket worker to:

1. Fetch the recorded remote baseline, create the ticket branch from its exact SHA, and re-read the ticket and mapped domain sources from that checkout.
2. Use the Matt `implement` workflow and TDD at an agreed seam where practical. Repository instructions and [DSH pre-push checks](../dsh-pre-push-checks/SKILL.md) override the Matt workflow's generic full-suite advice.
3. Preserve unrelated worktree changes. Add the required documentation, Agent Note, real runnable snapshot, and visual evidence when their repository rules apply.
4. Run the narrowest evidence that covers the diff through `dsh-pre-push-checks`, then commit, push, and verify the remote head.
5. Open or update a pull request targeting the delivery baseline. Link the ticket with `Refs`, carry canonical labels, explain the behavior and evidence, and leave release work out of scope; the final baseline-to-master pull request owns closing keywords.
6. Return the branch, commit, pull request, checks run, CI state, review blockers, and any changed dependency to the root task.

Complete a worker phase only when the remote pull request represents its full ticket diff and its reported evidence is reproducible.

## Review and land

1. Review each pull request against both the repository standards and its ticket/specification with `code-review` and `dsh-code-review`; use the project `dsh_reviewer` role when available. Send fixes to the owning worker.
2. Before each batch and before a ticket's final review, have the root merge-forward current `origin/master` into the delivery baseline once and push it. Each affected worker then merge-forwards the updated remote baseline into its ticket branch, audits semantic conflicts, reruns selected checks, and republishes the exact head. Sibling workers do not merge master independently.
3. Wait for required CI and live review state. Re-fetch the exact head, base, unresolved threads, approvals, checks, and mergeability after every rewrite or base change.
4. Merge an independent pull request into the delivery baseline only after its required local evidence, CI, review, and merge requirements pass. For dependent pull requests, follow [the official stack workflow](../dsh-merging-stacked-prs/SKILL.md) and land blocker-first.
5. Confirm GitHub reports the ticket pull request as merged, comment its verification evidence without closing the ticket, and recompute the ready frontier.
6. After every selected ticket is on the baseline, merge-forward current `origin/master`, run the feature-level assembled evidence, and open the reviewed baseline-to-master pull request with all closing keywords. Close tickets only after GitHub reports that final pull request merged into the default branch.
7. Resume a failed or interrupted worker from GitHub state. Ask the user only for missing credentials, permissions, a material product decision, conflicting official stack metadata, or release authorization.

Complete delivery when every selected ticket is merged or has a concrete reported blocker, GitHub reflects the final state, and no release mutation has occurred without approval.

## Retire completed work

1. After a ticket pull request lands on the baseline, verify its task is terminal and its exact worktree has no uncommitted files, stash, unpushed commit, or unique commit absent from the remote merged result. Preserve the worktree and report the discrepancy when any check fails.
2. Archive the terminal Codex task, remove only its validated worktree, delete its merged local and remote ticket branches, and run `git worktree prune`. For an official stack, wait until its descendants no longer depend on the branch.
3. After the baseline-to-master pull request lands and its tickets close, apply the same checks before removing the baseline worktree and branches. Record an explicit retention reason instead when follow-up work still needs them.

Complete cleanup when every removed path and branch was exact, merged, clean, and replaceable from GitHub, and every retained artifact has a named owner and reason.

## Report

Report baseline and ticket branches, merged ticket and final pull requests, checks actually run, cleanup or retention results, unresolved blockers, remaining ready tickets, and the explicit release stop point. If a newly installed skill or project agent is absent from the current task's catalog, ask the user to start one fresh Codex task once; do not require a new task per ticket.
