# Agent Note: Default ticket delivery orchestration

Status: implemented

English | [中文](2026-08-16-default-ticket-delivery-orchestration.zh.md)

## Problem

A short request to implement a ticket does not by itself tell a coding agent whether it may create worktrees, delegate, commit, push, open pull requests, or merge. Repeating that authority and the coordination topology in every prompt adds human work and still permits different sessions to choose incompatible stopping points.

Subagent transcripts are also a poor durable coordination record. A worker can be restarted, its task can lose context, and sibling communication support can vary by host or session. GitHub already stores the ticket graph, review state, checks, and merged result.

Uncommitted planning files create the same failure before dispatch: implementation tasks cannot read decisions that exist only in another checkout. Sending every ticket directly to `master` also lets an unfinished feature affect unrelated delivery and defers cross-ticket integration until after its pieces have already entered the default branch.

## Decision

The repository's [delivery orchestrator](../../../skills/orchestrate-dsh-delivery/SKILL.md) is the default workflow when a user asks to implement, fix, continue, or land an issue or specification. That request authorizes the root task to create isolated ticket worktrees and branches, dispatch workers, edit, commit, push, open or update pull requests, respond to review, and merge work whose required evidence passes. Explicit limits in the current request override the default.

Before the first workspace write, the root task creates and pushes one `codex/feature-<slug>` baseline from an exact `origin/master` commit. Confirmed prototype conclusions, specifications, Agent Notes, Context documents, and tickets are committed to that baseline before dispatch, and the planning checkout is clean. Each ticket branch starts from the recorded remote baseline commit and targets that baseline. The root task alone periodically merge-forwards `origin/master` into the baseline; workers then merge-forward the updated baseline instead of resolving the same master movement independently.

The root task is the coordinator and monitor. It analyzes, decomposes, dispatches, and accepts; it does not implement. [Root-session orchestration](2026-09-03-root-session-orchestrates-only.md) owns that split. [One specification pull request](2026-09-02-spec-pr-delivery-and-retro.md) is the merge into `master`; a merger subagent integrates ticket branches. GitHub Issues, that pull request, checks, and remote heads are durable state. Each ready ticket has one write-capable owner and one worktree; independent tickets may run concurrently. Read-heavy exploration and review may use subagents, while follow-ups and cross-ticket discoveries route through the root task as briefs to writers and are recorded in GitHub or the owning repository document. The root monitors every independent task and surfaces a structured human blocker in the coordinating task, so sibling-agent communication and manual task discovery are not required.

Project Codex roles encode the two recurring responsibilities: `ticket_worker` owns one ticket through its verified pull request without merging, and `dsh_reviewer` performs a read-only standards-and-specification review. If task or worktree creation is unavailable, the root dispatches writers sequentially through the Agent tool or reports the isolation failure; it does not write.

The [pre-push workflow](../../../skills/dsh-pre-push-checks/SKILL.md) selects outgoing evidence. GUI smoke and browser work follow the [Desktop test-instance and runtime-memo decision](2026-09-02-desktop-test-instance-and-runtime-memo.md). Writers do not open pull requests. After assembled evidence and the [retro gate](2026-09-02-spec-pr-delivery-and-retro.md) pass, the specification pull request enters `master` and closes the tickets. A terminal ticket task is archived and its worktree and branches are removed only after the root proves they are clean, pushed, merged, and reproducible from GitHub. Tag creation, GitHub Releases, publication, signing, notarization, and deployment always require explicit per-release approval.

## Alternatives considered

**Require a full delivery prompt for every request.** This keeps authority visible in each conversation but makes the user restate stable repository policy and creates avoidable differences between sessions.

**Use one long-lived task for all implementation.** This avoids task creation but mixes unrelated mutable state, grows context without bound, and weakens ticket-level recovery.

**Let workers coordinate directly.** Peer messaging can reduce root-task relays, but it makes transient agent topology part of the workflow and duplicates durable ticket and pull-request state.

**Merge every ticket directly into `master`.** This shortens each ticket path but exposes partial features to unrelated work, leaves planning state outside the implementation base, and removes the final feature-level integration decision.

**Let every worker merge current `master`.** This keeps long work current but duplicates conflict resolution across sibling branches. One root-owned baseline sync resolves upstream movement once and gives every worker the same integration point.

**Stop every ticket before push or merge.** This maximizes per-step confirmation but preserves the manual handoffs this repository default is intended to remove. Release mutations retain the human boundary because they affect distributed users and registries beyond the reviewed pull request.

## Consequences

A user can request implementation with a ticket number or specification reference and expect delivery through verified merge without repeating routine Git and GitHub permissions. The root task can replace or resume workers from GitHub state, and independent tickets can progress in parallel without shared writable checkouts. Implementation tasks receive committed planning authority, and unrelated features remain isolated until their final baseline pull requests enter `master`.

The specification branch is the integration point and the only pull request onto `master`. Tickets remain open until that merge. Upstream movement is admitted through merger-owned sync points. Cleanup waits for evidence that no unique work would be lost. Automatic merge still increases the importance of accurate ticket scope, repository checks, and live review-state inspection. Explicit user limits remain authoritative, unavailable isolation stops delivery instead of writing in the root session, and release work always pauses for approval.
