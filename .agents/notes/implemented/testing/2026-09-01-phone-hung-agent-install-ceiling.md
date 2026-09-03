# Agent Note: Hung agent-install ceiling proof

Status: implemented

English | [中文](2026-09-01-phone-hung-agent-install-ceiling.zh.md)

## Problem

`installAgent` without `force` runs a one-shot `agent status` child, then a one-shot `agent install` child, and both inherit the same `agentTimeoutMs` ceiling. A hung-install proof that keeps that ceiling near a loaded host's spawn cost can expire on the status probe instead of the install child, even when the fake's status path has no delay.

## Decision

The hung-install case in `packages/phone/phone-runtime/tests/agent.spec.ts` keeps a delay-free status probe and a short shared `agentTimeoutMs` that still exceeds a loaded host's status spawn, while the fake's install child hangs longer than that ceiling. The assertion names `agent install` because that is the child the case is proving; production still uses one `agentTimeoutMs` per child, not one deadline across both.

## Alternatives considered

**Skip the status probe with `force: true`.** Rejected: the production install path without `force` always probes first, and the flake is that probe under load.

**Match `agent status` or `agent install`.** Rejected: that would accept a status-probe timeout as proof of a hung install.

**Give status and install separate product ceilings.** Rejected: production already bounds each child independently with the same config field; the flake is the test's margin, not a missing product deadline.

## Consequences

The case waits longer than a 2s ceiling on loaded CI, but still names the install child. Tightening `agentTimeoutMs` back toward spawn cost will recreate the status-probe timeout.
