---
name: orchestrate-dsh-delivery
description: >-
  Orchestrate DeepSeek Harness issue and specification delivery through isolated
  writers, one specification pull request, review, retro, and merge. Use when the
  user asks to implement, fix, continue, or land repository work, including
  "implement #123" and "continue this spec".
---

# Orchestrate DSH Delivery

Own the delivery graph from the root task. Treat GitHub Issues, the specification pull request, checks, and remote heads as durable coordination state. Use Codex tasks and DSH subagents or forks as replaceable executors, not as the source of truth. The root session analyzes, decomposes, dispatches, and accepts; it does not implement. [Root-session orchestration](../../notes/implemented/process/2026-09-03-root-session-orchestrates-only.md) owns that split. GUI draft comparison and the dedicated acceptance walk live in [the fidelity-and-acceptance-route decision](../../notes/implemented/process/2026-09-03-ui-fidelity-and-acceptance-route.md). Pull-request cardinality, merger ownership, scratch exploration notes, and the retro gate live in [the spec-PR decision](../../notes/implemented/process/2026-09-02-spec-pr-delivery-and-retro.md). Request authority, isolated writers, GUI evidence, cleanup proofs, and the release stop remain in [the default-orchestration decision](../../notes/implemented/process/2026-08-16-default-ticket-delivery-orchestration.md).

## Establish authority

1. Read [the tracker contract](../../../docs/agents/issue-tracker.md), [domain routing](../../../docs/agents/domain.md), `CONTEXT-MAP.md`, and the applicable repository instructions and active Agent Notes.
2. Fetch the complete issue or specification, including comments, labels, acceptance criteria, dependencies, and current pull requests. Resolve ambiguous GitHub numbers as the tracker contract requires.
3. Interpret a request to implement, fix, continue, or land the work as authorization to create branches and isolated worktrees, edit files, commit, push, open or update the specification pull request, respond to review, and merge after required evidence and the retro gate pass. An explicit user limit such as "do not push" or "stop before merge" overrides this default.
4. Keep tag creation, GitHub Releases, registry publication, signing, notarization, deployment, and other release mutations behind explicit per-release approval. Ticket delivery does not authorize them.

Complete this phase when the requested outcome, live ticket graph, mutation authority, and release stop point are explicit.

## Keep the root on orchestration

1. Restrict the root session to demand clarification, scheme decomposition, task dispatch, and result acceptance. Before dispatch or continuation, apply [delegation routing and context reuse](../../../docs/agents/delegation-routing.md): choose an explicit available provider/model under current user restrictions, and reuse a suitable direct child only when independence and a model change are unnecessary.
2. Dispatch implementation through the runtime's Agent tool: under DSH, `subagent` or `subagent_fork`; under Codex, a worktree task when available. Implementation is reading a large code surface to change it, writing or editing product or documentation files, running local tests or other executable evidence, and bulk edits.
3. Treat user feedback, CI failures, review findings, and retro keep-or-drop landings the same way, including after the specification looks done. Classify the work, brief a writer, wait, and accept reported evidence. Do not implement the follow-up in the coordinating session.
4. The root may read GitHub, the tracker, worker reports, and CI status; write a brief; create an empty specification branch and Draft pull request; and enqueue a merge once reported evidence passes. It does not land code, documentation, or environment edits in the coordinating checkout.
5. When no Agent tool can run a writer, report that isolation failure and stop. Do not fall back to implementing in the coordinating session.

Complete this phase when every implementation path has a named writer executor, including late feedback.

## Establish the specification branch

1. Before the first workspace write, require a clean checkout, fetch `origin/master`, and create and push one remote `codex/feature-<slug>` specification branch from its exact SHA. If work already exists in a dirty checkout, stop new writes, preserve the diff, and migrate it into a clean specification worktree without moving or cleaning the dirty checkout first.
2. Keep planning authority on that branch: confirmed prototype conclusions, specification, Agent Notes, Context documents, published tickets, and for a GUI change the frozen draft plus the experience route, must be committed and pushed before implementation dispatch. Local conversation history is not a handoff artifact. A GUI specification without that draft pointer and route is not ready.
3. Record the specification branch and exact remote SHA in every worker handoff. Verify the ticket's accepted requirements and mapped domain sources are readable from that SHA.
4. Keep one specification branch per independently releasable feature or fix. Parallel delivery scopes use separate branches; extract genuinely shared foundations into their own master-bound delivery instead of copying them between scopes.
5. Open or update one Draft pull request from that branch to `master`. It is the only pull request that will close the specification and tickets. Do not open a pull request per ticket.

Complete this phase when the specification branch is remotely visible, the planning checkout is clean, the Draft pull request exists, and every implementation input is durable at the recorded SHA.

## Build the delivery frontier

1. Decompose only when the source is not already ticketed. Use the Matt specification and ticket skills for product shaping and blocker-first ticket publication; do not rewrite accepted ticket scope during implementation.
2. Order tickets by live dependency state. A ready frontier contains only tickets whose blockers are already on the specification branch.
3. Keep independent tickets as independent writer branches. Stack pull requests only when a leftover dependency still needs GitHub's official stack after this topology cannot express it.
4. Follow the [runtime-specific executor decision](../../notes/implemented/process/2026-08-27-runtime-specific-delivery-executors.md) for product-shaping work. Do not draw UI or write a scheme in the coordinating session. Under Codex, create an independent Codex Worktree task with a short brief. Under DSH, use `subagent_fork` only when the brief is already written; otherwise dispatch a plain `subagent`. Brief a UI writer to follow [prototype](../prototype/SKILL.md): fuse interaction variants into the existing page, self-check headless through [dsh-desktop-test-instance](../dsh-desktop-test-instance/SKILL.md), then open a headed instance only to ask the user to review. Brief a scheme writer to follow [codebase-design/SCHEME.md](../codebase-design/SCHEME.md): write the proposed Agent Note on the specification branch, self-check it, then open a gitignored HTML review pack for the human. Keep prototype code on its own pushed worktree and branch. Implementation tickets adapt that code instead of merging it verbatim; retire the prototype branch once its consuming tickets have landed.
5. Put exploration notes in a scratch directory outside the repository. Record its absolute path in the gitignored runtime memo so later writers can read it. Do not commit those notes.

Complete this phase when every selected ticket has one writer branch, one acceptance source, and a known dependency position.

## Dispatch isolated writers

1. Keep the root task as coordinator and monitor. It does not merge writer branches. Match the writer executor to the runtime: under Codex, prefer one Codex Worktree task per ready ticket when task/worktree tools are available; under DSH, choose continuation, `subagent`, or `subagent_fork` through [the routing reference](../../../docs/agents/delegation-routing.md). Pass an explicit available provider/model when the tool supports routing; no role pins a model. On the normal path, every writer commits only inside its own isolated worktree. Assign the project `ticket_worker` role when custom agents are available.
2. Give each worker exactly one ticket, one `codex/<issue>-<slug>` branch, one worktree, the verified remote specification branch and SHA, the scratch exploration path when one exists, the acceptance criteria, and the required reporting format. Never let two writers mutate the same worktree.
3. Allow read-heavy exploration, log analysis, and review to run as subagents inside a ticket. Keep one writer for that ticket unless every writer has a disjoint worktree and branch.
4. Route follow-ups and dependency discoveries through the root task as briefs to writers. Sibling agents need no direct communication. Record durable cross-ticket facts in the relevant Issue, the specification pull request, Context document, or Agent Note.
5. When Codex task creation is unavailable but an isolated worktree can still be created, dispatch writers sequentially into one dedicated worktree at a time through the Agent tool; the root still does not write. If the active runtime cannot create an isolated worktree or cannot run an Agent tool, report the isolation failure and stop.

Complete this phase when every ready ticket has one accountable writer and no mutable checkout has multiple owners.

## Supervise asynchronous workers

1. Treat dispatch as a monitored handoff. Register every independent executor — a Codex task, a fresh Codex session, or a background `subagent` run — in one active wait set and keep the root session alive with bounded waits while any selected worker is running. Preserve task cursors and re-wait after unchanged timeouts without narrating them.
2. Let a completion or attention event resume the root session. Read the result, answer worker needs, route follow-up work, and return the executor to the wait set until it reaches a terminal state. Continue supervising the other workers in parallel.
3. Require a human blocker to end with `[BLOCKED · Issue #N]`, one concrete requested action, and the evidence that makes it necessary. Surface that request from the root session; never leave the user to discover it in an implementation task.
4. Keep follow-up ownership in the root session. The user need not ask to continue before the root observes completion. Yield only for missing authority or input, or after all selected workers are terminal and their results have been incorporated into the delivery graph.

Complete this phase when every dispatched executor's final state has been observed and acted on, and no selected worker remains unwatched.

## Enforce the worker contract

Require each ticket worker to:

1. Fetch the recorded remote specification branch, create the ticket branch from its exact SHA, and re-read the ticket and mapped domain sources from that checkout. Read scratch exploration notes when the handoff recorded a path.
2. Follow the shared implementation workflow in [`implement`](../implement/SKILL.md) as an ordinary reference; it is a user-invoked entry, not a required automatic Skill-tool call. Use TDD at an agreed seam where practical, then select narrow checks through [DSH pre-push checks](../dsh-pre-push-checks/SKILL.md).
3. Preserve unrelated worktree changes. Add the required documentation, Agent Note, and real runnable snapshot when their repository rules apply. For a GUI change, prove the ticket's slice of the experience route with a non-recording smoke through [dsh-desktop-test-instance](../dsh-desktop-test-instance/SKILL.md) (headless) and [ego-browser](../ego-browser/SKILL.md) (one DSH task space per goal). Do not start a headed instance for the user. Defer GIF recording and the whole-route walk until the fidelity and acceptance sessions below.
4. Run the narrowest evidence that covers the diff through `dsh-pre-push-checks`, then commit, push, and verify the remote ticket head. Do not open a pull request.
5. Return the branch, commit, checks run, review blockers, scratch notes path, and any changed dependency to the root task.

Complete a worker phase only when the remote ticket branch represents its full ticket diff and its reported evidence is reproducible.

## Merge through a merger subagent

1. Dispatch a merger subagent, not the root session, to integrate each completed ticket branch into the specification branch. Fast-forward when the histories allow it; otherwise create a merge commit. Push the specification branch and report the new head.
2. After a successful merge, recompute the ready frontier and dispatch newly unblocked writers.
3. Before each batch, have the merger subagent merge-forward current `origin/master` into the specification branch once and push it. Affected in-flight writers then merge-forward that updated remote head into their ticket branches, audit semantic conflicts, and republish the exact head. Sibling writers do not merge master independently.
4. For leftover GitHub-level dependencies that this single pull request cannot express, follow [the official stack workflow](../dsh-merging-stacked-prs/SKILL.md).

Complete this phase when every selected ticket commit is on the specification branch or has a concrete reported merge blocker.

## Review, fidelity, acceptance route, retro, and land

1. Run the narrow deterministic checks needed before visual comparison. Do not spend model calls or capture frames for a final GIF yet. Do not start a headed instance for the user.
2. Review the specification pull request against both the repository standards and the specification with `code-review` and `dsh-code-review`; use the project `dsh_reviewer` role when available. Send code fixes to the owning writer, then merge them through the merger subagent, until no code finding remains. Spec review of prose is not visual fidelity.
3. For a GUI change, dispatch a fidelity writer. That writer starts one headless Desktop through [dsh-desktop-test-instance](../dsh-desktop-test-instance/SKILL.md), opens every screen on the experience route, and compares it to the frozen draft named by the specification (`gif-assets` PNG/GIF and the throwaway prototype branch). Require the same chrome, component library, information hierarchy, and primary affordance. Pixel-identity is not required. Send each mismatch to the owning ticket writer and merge the fix through the merger subagent. Do not start headed review while a mismatch remains.
4. Dispatch a dedicated acceptance-environment session, not the root and not a ticket writer. That session stops leftover instances for this goal, starts one fresh isolated Desktop, chooses fixture versus live Platform from the scenario, seeds the data the experience route needs, and walks every step of that route headless. A blocked step is a writer fix or a structured human blocker; it is not a headed handoff. Only a complete headless walk starts a headed instance. Then give the user the route, the URL or window, and the starting state.
5. Freeze the exact reviewed specification head after fidelity and the acceptance walk pass. For a product-user-visible GUI change, record and publish the required GIF from that head with `record-browser-gif`; verify the served revision before the first real-model call or captured frame. Any code change after freezing invalidates the review, fidelity, acceptance-walk, and recording sequence: merge-forward if needed, re-run affected checks, re-review, re-compare, re-walk, freeze the new head, and re-record.
6. Ask each writer session to run [`retro`](../retro/SKILL.md) on its own session. Collect the candidates in the root task, present a synthesized list to the user, and wait for an explicit keep-or-drop decision per item. Dispatch a writer to land only accepted environment changes on the specification branch, then accept the writer's re-run of the affected checks. Do not merge to `master` before that decision.
7. Wait for required CI and live review state. Re-fetch the exact head, base, unresolved threads, approvals, checks, and mergeability after every rewrite or base change.
8. Mark the specification pull request ready. Its body carries `Closes` for the specification and every delivered ticket. Merge it only after local evidence, CI, review, fidelity, the acceptance walk, the retro decision, and merge requirements pass.
9. Confirm GitHub reports that pull request as merged and its tickets closed. Resume a failed or interrupted worker from GitHub state. Ask the user only for missing credentials, permissions, a material product decision, a retro keep-or-drop, a blocked experience-route step, conflicting official stack metadata, or release authorization.

Complete delivery when every selected ticket is on `master` or has a concrete reported blocker, GitHub reflects the final state, GUI fidelity and the experience route have passed when they apply, the retro decision is recorded, and no release mutation has occurred without approval.

## Retire completed work

1. After the specification pull request lands, verify each writer is terminal through the owning runtime's task, subagent, or session state. Verify that its exact worktree has no uncommitted files, stash, unpushed commit, or unique commit absent from the remote merged result. Preserve the worktree and report the discrepancy when any check fails.
2. Archive a terminal Codex task only when that writer created one. Remove only a validated dedicated worktree, retain any shared checkout, delete merged local and remote ticket branches and the specification branch, and run `git worktree prune`.
3. Record an explicit retention reason instead when follow-up work still needs a path or branch. Delete the scratch exploration directory after the user has not asked to keep it.

Complete cleanup when every removed path and branch was exact, merged, clean, and replaceable from GitHub, and every retained artifact has a named owner and reason.

## Report

Report the specification branch and pull request, ticket branches, checks actually run, merger results, fidelity findings, experience-route status, retro candidates and user decisions, cleanup or retention results, unresolved blockers, remaining ready tickets, and the explicit release stop point. After an explicitly authorized Product Release, read its machine-readable manifest and report Desktop, Mobile, and Platform as separate released, skipped, or blocked states; a merged release plan is not publication evidence. If a newly installed skill or project agent is absent from the current task's catalog, ask the user to start one fresh Codex task once; do not require a new task per ticket.
