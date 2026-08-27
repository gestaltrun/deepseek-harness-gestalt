# Agent Note: A product fork clears its inherited goal

Status: implemented

English | [中文](2026-08-27-product-fork-clears-inherited-goal.zh.md)

## Problem

A side conversation is created by `session.fork`: the child session is seeded with a prefix of the parent's event log. `goal/change` events inside that prefix fold into the child's current goal, so the forked thread inherits a full copy of the parent's objective — visible to `get_goal`, eligible for `resume`/`complete`, and shown by goal UI. The [goal-owned durable events](../architecture/2026-07-31-goal-owned-durable-events.md) decision accepted fork inheritance as a consequence of log-backed persistence, and activation disarming already prevented automatic continuation. But a side thread is a new parallel human thread, not a continuation of the parent's objective: owning a mutable copy of the parent's goal across threads is a thread-isolation defect, regardless of arming.

## Decision

`clearGoalFromForkSeed(seed)` is a pure pre-publication transform owned by the goal package. It folds the contiguous parent prefix and, when a current goal exists, returns a new seed with one trailing clear tombstone. The host keeps `header.seedLength` equal to the parent-prefix length, so the tombstone is in the child's owned suffix while `AgentRegistry.create` admits the complete seed and publishes the child atomically. A malformed prefix or clear change fails before the child exists.

Automation seeding is unchanged: subagent fork providers seed child logs directly and keep the inherit-then-disarm posture, because an automation child never owns the parent's objective as a human thread does.

The persistence decision this narrows stays active. The session log remains the only durable authority, and fork inheritance remains a storage property; product fork creation terminates it explicitly.

## Alternatives considered

**Filter `goal/change` out of the fork seed.** The seed must stay contiguous from seq 0; interior removal breaks the replay contract. Cutting before the first goal event is impractical and would hide conversation history.

**Clear through `GoalService` after child creation.** Creation publishes session and agent lifecycle events before returning. Listeners could observe the inherited goal, and a clear failure would leave a published child that violates product fork isolation.

**Disarm on fork only.** Already the shipped behavior; it stops continuation but leaves the goal visible and mutable in the child, which is the reported defect.

**Mask the goal in views by lineage metadata.** Diverges the log from every projection and tool read; a second authoritative source for "has this thread a goal".

**Backfill existing forked sessions.** Rejected: the sweep is a creation-time verb, and rewriting historical logs for a presentation fix is out of proportion. Recorded as a Known Limitation.

## Consequences

Newly forked side threads start goalless and may create their own goal; the source thread's goal is untouched. `tool-goal`'s model-visible description is unchanged because its fork sentence describes arming, which remains true for seeded automation children. Existing forked sessions keep showing the inherited goal until cleared by hand. Package tests pin the pure seed transform, no-goal identity case, completed-goal case, and automation inheritance; the api-proxy fork suite pins pre-publication isolation and the untouched source.
