# Agent Note: Phone contracts-ready lint closure

Status: implemented

English | [中文](2026-08-31-phone-contracts-ready-lint.zh.md)

## Problem

The phone delivery added source, lifecycle tests, generated catalog fixtures, and assembled snapshot coverage before every touched file satisfied the repository's type-aware lint rules. The remaining diagnostics represented concrete obligations: unknown rejection values needed narrowing, promise ownership needed to be explicit, void callbacks needed block bodies, and lifecycle facts needed to be re-read after an await.

## Decision

The phone delivery surface passes `lint:contracts-ready` without rule disables, file exclusions, weakened types, or broad assertions. Wire and JSON values remain `unknown` until narrowed. Tests await asynchronous port claims, mark deliberately unobserved promises with `void`, and use block-bodied callbacks when their return values are not part of the contract. Lifecycle checks call a helper after each suspension point so the fiber state is read at the time of the decision. Generated phone fixtures preserve their promised service interface without an unnecessary `async` function.

## Alternatives considered

**Exclude generated fixtures and tests from type-aware lint.** Rejected: these files assemble shipped contracts and lifecycle evidence, so unsafe values or floating promises can invalidate the proof even when product source is unchanged.

**Suppress individual diagnostics.** Rejected: every diagnostic had a local expression that stated the existing obligation directly.

## Consequences

Phone source, tests, snapshots, and catalog fixtures use the same contracts-ready rules as the rest of the repository. Future changes must preserve explicit rejection narrowing, promise ownership, and post-await lifecycle reads.

## Verification

`pnpm run lint:contracts-ready` passes on the final stacked phone delivery. Focused phone, workbench, snapshot, and catalog tests preserve their prior behavior.
