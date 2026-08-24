# Agent Note: pwsh Post-command Readiness

Status: implemented

English | [中文](2026-08-24-pwsh-post-command-readiness.zh.md)

## Problem

The profile-owned pwsh stdin loop can report that the shell process group is waiting in `ReadLine` immediately after a terminal write but before it consumes the submitted line. Under load, the exact stdin-wait tier could settle the send with only the echoed command, dropping the command output from the operation result.

## Decision

The pwsh shell process group settles through its owned post-command prompt or the bounded silence and timeout tiers. Provider-reported stdin wait remains exact readiness when pwsh transfers the terminal to a different foreground process group, preserving interactive-child behavior. Bash keeps its existing stdin-wait rules.

## Alternatives considered

**Increase the real-shell test timeout.** Rejected because the operation had already settled; additional assertion time cannot recover output that no longer belongs to the send.

**Disable exact stdin waits for every pwsh foreground.** Rejected because a changed foreground process group is generation-owned evidence for an interactive child.

**Accept command echo as output.** Rejected because echo proves only that the terminal received bytes, not that pwsh executed the line or produced its result.

## Consequences

Commands in the pwsh shell group cannot settle before their post-command prompt. Interactive children in another process group retain exact stdin-wait readiness, while marker loss still degrades to the existing bounded silence tier.

## Testing

The session test reproduces an early same-group stdin wait after echoed input and requires the owned prompt before settlement. A companion case verifies exact readiness for a changed pwsh foreground group. The real-pwsh UTF-8 test remains the process-level regression on Linux CI.
