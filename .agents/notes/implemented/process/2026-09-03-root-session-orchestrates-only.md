# Agent Note: Root session orchestrates only

Status: implemented

English | [中文](2026-09-03-root-session-orchestrates-only.zh.md)

## Problem

Late-stage user feedback, CI failures, and small follow-up edits sit outside the ticket-writer loop in practice. The coordinating session then reads the codebase, writes the fix, and runs tests in its own context. That mixes analysis with implementation, spends the root window on code, and leaves no isolated writer to resume.

## Decision

The [delivery orchestrator](../../../skills/orchestrate-dsh-delivery/SKILL.md) keeps the root session on analysis, decomposition, dispatch, and acceptance. It clarifies the request, splits work, chooses an executor and model, waits, and judges reported evidence. It does not implement.

Implementation is any of: reading a large code surface to change it, writing or editing product or documentation files, running local tests or other executable evidence, and bulk edits. The root dispatches that work through the runtime's Agent tool (`subagent`, `subagent_fork`, or a Codex worktree task) to the most appropriate model for that ticket. User feedback at any phase, including after the specification looks done, is classified and sent to a writer the same way.

The root may read GitHub, the tracker, worker reports, and CI status; write a brief; create an empty specification branch and Draft pull request; and enqueue a merge once reported evidence passes. It does not land code, documentation, or environment edits in the coordinating checkout, and it does not start the headed acceptance instance or walk the experience route. [The spec-PR decision](2026-09-02-spec-pr-delivery-and-retro.md) still owns pull-request cardinality, the merger subagent, scratch notes, and the retro gate. [The fidelity-and-acceptance-route decision](2026-09-03-ui-fidelity-and-acceptance-route.md) owns draft comparison and the dedicated acceptance session. [Runtime-specific executors](2026-08-27-runtime-specific-delivery-executors.md) still choose Codex versus DSH workers; sequential dispatch is sequential isolated writers, not the root writing.

When no Agent tool can run a writer, the root reports that isolation failure and stops. It does not fall back to implementing in the coordinating session.

## Alternatives considered

**Let the root fix late feedback in place.** A one-line follow-up is faster in the coordinating context. It also spends the analysis window on code, has no isolated worktree to resume, and trains the root to treat "small" as a license to implement.

**Keep the root as sequential writer when Codex tasks or worktrees are unavailable.** That preserves progress under a reduced executor. It is the same coordinating-session implementation this decision forbids. Missing writer tools are a reported blocker.

**Allow the root to land accepted retro edits in the planning checkout.** The files are environment steering, not product code. They are still implementation in the coordinating session; a writer lands them on the specification branch.

## Consequences

The root context stays on the delivery graph, including feedback after the last ticket. Every code, test, and documentation change has a writer to resume. Dispatch pays a brief-and-wait cost for small follow-ups. A missing Agent tool stops delivery instead of silently implementing in the root session.
