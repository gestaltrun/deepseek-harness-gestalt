# Agent Note: Retry Transient Windows Atomic Replacements

Status: implemented

English | [中文](2026-09-01-windows-atomic-replacement-retry.zh.md)

## Problem

Windows can temporarily deny replacement of an existing file while a scanner or another process still holds a handle. The complete random-suffix temp file remains valid, but failing the first `rename` reports a durable-store commit as failed even when the target becomes replaceable moments later.

## Decision

`writeFileAtomic` retries `rename` only on Windows and only for `EPERM`, `EACCES`, and `EBUSY`. It reuses the same fully written same-directory temp file after fixed delays of 10, 20, 40, 80, and 160 milliseconds, preserving the single atomic commit point and the caller-stated mode.

Every other error and platform fails immediately. Exhausting the 310-millisecond retry window rethrows the final filesystem error after removing the temp file; the primitive does not reinterpret a persistent permission failure as contention.

## Alternatives considered

**Retry at each durable-store caller.** Caller-level retries duplicate filesystem policy and may repeat encryption, rendering, or surrounding state changes. The atomic replacement primitive owns the exact operation that is safe to repeat.

**Retry every rename failure on every platform.** Structural errors such as an invalid target hierarchy cannot become valid through delay. Restricting the retry to the observed Windows access-error family keeps unrelated failures immediate.

**Require `withFileLock` around every already-rendered commit.** A writer lock is required for read-modify-write cycles, but independent complete replacements may safely race at the atomic commit point. Mandatory locks would add timeout and orphan-recovery behavior without removing transient scanner handles.

## Consequences

A persistent Windows access failure takes up to 310 milliseconds longer to reach the caller. Successful replacement, symlink-target replacement, permission narrowing, lock semantics, and non-Windows failure timing remain unchanged.

## Testing

The atomic-write suite injects three transient Windows error codes before success, exhausts the bounded retry count, verifies immediate non-Windows failure, and checks target content plus temp-file cleanup. The Desktop account-store concurrency case exercises the original complete-record replacement path. Issue [#507](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/507) owns the correction.
