# Agent Note: Runtime-specific delivery executors

Status: implemented

English | [中文](2026-08-27-runtime-specific-delivery-executors.zh.md)

## Problem

The delivery workflow named Codex worktree tasks as its preferred ticket writer even when the workflow ran inside DSH. DSH does not own Codex task lifecycle operations, and a plain subagent does not inherit the specification conversation needed by some product-shaping prototypes. Applying one executor rule to both runtimes could select an unavailable lifecycle API or discard useful planning context.

## Decision

The root coordinator selects writers from the active runtime. Codex uses isolated Codex worktree tasks when they are available. When the Codex task API is unavailable but worktree isolation remains available, the root becomes the sole sequential writer inside one dedicated worktree at a time. DSH uses `subagent_fork` when the writer benefits from the current conversation and plain `subagent` when inheritance adds nothing. A UI prototype is not drawn in the coordinating session: Codex gets an independent worktree task with a short brief; DSH gets a subagent after that brief exists. [Fused UI prototype variants](2026-09-02-fused-ui-prototype-variants.md) own the draft rules. Model selection remains a per-ticket root decision.

On the normal path, every writer receives one ticket, branch, and isolated worktree. The loss of worktree isolation is the sole exception: it activates the shared-checkout fallback, where the root remains the sole sequential writer and reports the reduced isolation. A product-shaping prototype lives on its own pushed branch and supplies planning input that implementation tickets adapt rather than merge verbatim. Cleanup verifies terminal state through the executor that actually ran; it archives a Codex task only when one was created and never removes a shared checkout. Exact dedicated-worktree and branch validation remains common cleanup behavior.

## Alternatives considered

**Always use Codex tasks.** This keeps one instruction path but names lifecycle operations that DSH cannot perform.

**Always use plain DSH subagents.** This works for context-free execution but withholds the accepted specification conversation from prototypes and writers that need it.

**Merge prototype branches into ticket branches.** This preserves prototype commits but turns exploratory code into implementation history before the ticket writer has adapted it to production constraints.

## Consequences

- Each runtime uses the executor and lifecycle operations it owns.
- DSH can preserve specification context selectively instead of copying it into every task.
- Writer isolation and durable branch evidence remain invariant across runtimes on the normal path; the shared-checkout fallback makes lost isolation explicit.
- Prototype code requires an explicit adaptation step and its temporary branch remains until all consuming tickets land.
