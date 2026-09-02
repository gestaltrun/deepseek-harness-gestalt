# Agent Note: Desktop test instance and runtime memo

Status: implemented

English | [中文](2026-09-02-desktop-test-instance-and-runtime-memo.zh.md)

## Problem

Agent-started Desktop Electron instances and ego-lite task spaces had no durable local inventory. A request to start a test program often launched another visible window beside leftover Host, PostgreSQL, sidecar, scratch-home, and SysV shared-memory state from the same goal. Browser work could create a new DSH task space on later rounds even when the first space still existed. Model calls from those instances also had no rule that they inherit the provider catalog already stored in the normal DSH Home.

## Decision

[`dsh-desktop-test-instance`](../../../skills/dsh-desktop-test-instance/SKILL.md) owns agent-started Desktop test Electron lifecycle. One user goal has one instance. The agent stops the recorded instance, then any other live test processes for that goal, before a replacement starts. Pre-acceptance self-test is headless; a headed window starts only when the user asks to look, click, or accept. A model-calling instance blind-copies only `settings.yaml` and `.credentials.yaml` from the normal DSH Home through `copyModelConfiguration` in `scripts/web-acceptance.ts` and does not invent provider models.

`.agents/local/runtime-memo.json` is gitignored checkout-local inventory. Desktop records PIDs, ports, and scratch paths there; [`ego-browser`](../../../skills/ego-browser/SKILL.md) records the live DSH task-space id in the same file and reuses that id until the user asks for a fresh space, the goal changes, or the recorded space is gone. Creating a second DSH space while the first still exists fails the round.

[`orchestrate-dsh-delivery`](../../../skills/orchestrate-dsh-delivery/SKILL.md) points at those two skills for GUI smoke and browser work. Automated lanes such as `pnpm --dir apps/desktop test:e2e-sub2api` keep their own teardown and stay outside this instance skill.

## Alternatives considered

**Write the launch and cleanup steps into root `AGENTS.md`.** Those steps fire only on Desktop or browser work. A standing-order paragraph would spend context on every turn.

**Store process ids only in conversation.** Sessions compact, fork, and restart. A gitignored memo is the inventory a later round can read without reconstructing PIDs from chat.

**Kill leftovers with a command-line substring match.** A pattern that matches the cleanup shell, or another project's PostgreSQL, is not an exact owner. Recorded PIDs and paths are the stop list.

**Let headed and headless instances share the user's normal `DSH_HOME`.** That mixes test state into the installed product home and can leave the user's provider catalog dirty. The scratch copy is the isolation.

**Create a new ego task space whenever a heredoc starts.** Ego runtimes forget in-process bindings across heredocs, but the task space itself can persist. The memo plus `listTaskSpaces()` is the reuse check.

## Consequences

Agents can replace a test Electron without leaving a second window, Host, or database on the machine, and browser work stays in one DSH space for the goal. Model calls from those instances use the installed provider catalog instead of a fixture default.

The memo is local and can go stale; a missing process deletes its record rather than blocking the next start. Headed acceptance still needs an explicit user request. Automated Electron lanes remain responsible for their own survivors.
