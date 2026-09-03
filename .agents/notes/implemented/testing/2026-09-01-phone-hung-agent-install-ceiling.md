# Agent Note: Hung agent-install ceiling proof

Status: implemented

English | [中文](2026-09-01-phone-hung-agent-install-ceiling.zh.md)

## Problem

`installAgent` without `force` runs a one-shot `agent status` child, then a one-shot `agent install` child, and both inherit the same `agentTimeoutMs` ceiling. A hung-install proof that keeps that ceiling near a loaded host's spawn cost can expire on the status probe instead of the install child, even when the fake's status path has no delay.

## Decision

The hung-install case in `packages/phone/phone-runtime/tests/agent.spec.ts` calls `installAgent(id, { force: true })` so the status probe does not run. The 2s `agentTimeoutMs` then bounds only the hung `agent install` child. The assertion names `agent install` because that is the child the case is proving; production still uses one `agentTimeoutMs` per child.

## Alternatives considered

**Keep the status-first path and raise the shared ceiling.** Rejected: a delay-free status probe still loses the 2s race under CI spawn load, and a larger shared ceiling waits on both children instead of isolating install.

**Match `agent status` or `agent install`.** Rejected: that would accept a status-probe timeout as proof of a hung install.

**Give status and install separate product ceilings.** Rejected: production already bounds each child independently with the same config field; the flake is the test's probe, not a missing product deadline.

## Consequences

The hung-install proof no longer exercises the status-first install path. Adjacent cases still cover the probe, and this case still names the install child.
