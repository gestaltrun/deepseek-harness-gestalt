# Agent Note: One specification pull request with a retro gate

Status: implemented

English | [中文](2026-09-02-spec-pr-delivery-and-retro.zh.md)

## Problem

Per-ticket pull requests, a root session that merges, and exploration notes committed onto the planning branch multiply GitHub objects and keep the coordinating context on the merge path. A specification already has a ticket graph. Reviewers want one branch that implements it. After the code is ready, session-level environment waste is still invisible unless each writer runs a retrospective and the user chooses what to keep.

## Decision

[Delivery orchestration](../../../skills/orchestrate-dsh-delivery/SKILL.md) lands one specification on one pull request. That pull request targets `master`, carries every ticket's closing keywords, and is the only merge into the default branch for the delivery.

The root task still owns authority, dispatch, monitoring, human blockers, and the release stop. It does not merge worker branches. A merger subagent fast-forwards or merge-commits each completed ticket branch into the specification branch and reports the new head.

Each ready ticket still has one writer, one `codex/<issue>-<slug>` branch, and one isolated worktree. Writers follow [`implement`](../../../skills/implement/SKILL.md) and [pre-push checks](../../../skills/dsh-pre-push-checks/SKILL.md). They do not open pull requests.

Exploration notes stay outside version control in a scratch directory whose absolute path is recorded in the gitignored [runtime memo](2026-09-02-desktop-test-instance-and-runtime-memo.md). Planning authority that later workers must read (specification, Agent Notes, tickets) remains committed on the specification branch before dispatch.

After the specification branch has every ticket, required checks, and a clean standards-and-spec review, the root asks each writer session to run [`retro`](../../../skills/retro/SKILL.md). The root synthesizes those candidates, presents them to the user, and lands only the accepted environment changes on the same specification pull request. Merge to `master` waits for that user decision.

The [earlier default-orchestration note](2026-08-16-default-ticket-delivery-orchestration.md) still owns request authority, isolated writers, GitHub as durable state, GUI evidence, cleanup proofs, and the release stop. This note owns pull-request cardinality, who merges, where exploration notes live, and the retro gate.

## Alternatives considered

**One pull request per ticket, plus a baseline-to-master pull request.** This isolates review per ticket and keeps closing keywords off incomplete work. It also creates a stack of GitHub objects for one specification and leaves the root session on the merge path.

**Let the root session merge worker branches.** The coordinator already watches every writer. Merging there mixes integration conflicts into the same context that must keep dispatching and reporting blockers.

**Commit exploration notes onto the specification branch.** Later writers can read them from git, but the branch then carries discarded search. A shared scratch path recorded in the runtime memo is readable without becoming history.

**Run retrospectives only after merge to `master`.** That loses the chance to land environment fixes with the same reviewed change. The gate costs one user decision and can delay merge.

**Replace ticket writers with [`implement-spec`](../../../skills/implement-spec/SKILL.md) as the whole coordinator.** That skill's ticket graph, concurrent implementers, and single pull request match this topology. It does not own Gestalt labels, Desktop evidence, official stacks when a leftover dependency remains, the retro gate, or the release stop. This repository keeps those in the delivery skill and uses `implement-spec` as the worker-and-merger pattern, not as the root workflow.

## Consequences

Reviewers see one specification pull request instead of a ticket stack. Integration conflicts land in a merger subagent instead of the coordinating session. Exploration search does not enter `master`. Environment improvements chosen in retro share the same merge as the product change.

A merger failure or a rejected retro candidate can delay the only path onto `master`. Closing keywords fire only when that pull request lands, so GitHub Issues stay open while workers are still merging. Scratch exploration notes vanish with the machine unless the user asks to keep them.
