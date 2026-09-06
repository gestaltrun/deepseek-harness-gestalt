# Agent Note: Host-alive phone runtime occupancy pool

Status: implemented

English | [中文](2026-09-06-phone-runtime-pool-occupancy.zh.md)

## Problem

`PhoneDevices` owns one mobilecli generation (`serverPort`, one child). #574 needs one shared external generation plus N isolated iOS generations without Session/device product leases. A shared-generation stub reused the first Adapter start for every acquire, so isolated listings, capture, and dispose could not stay independent.

## Decision

`packages/phone/phone-runtime/src/runtime-pool.ts` is an internal external-occupancy core. Each `acquireExternal` mints a new `PhoneRuntimeOccupancyId` and handle. Two external acquires share one Host-lifetime slot and one generation. `acquireIsolatedIos` stays on the type and rejects `PHONE_UNAVAILABLE` until a private HOME/simulator-set/listen-bind provider exists; it never falls back to the external generation. `PhoneRuntimeGeneration` has no dispose. Caller drop is `handle.release()` for that occupancy only. The pool stores the Adapter-returned `stop` bound to that child. Late start after abort/replace/dispose calls **that** `stop` and does not install. Replace bumps epoch; old handles reject `PHONE_ABORTED` and must not stop the new child. `stopExternal` leaves occupancies live, generation gone, ops `PHONE_UNRESOLVED`, epoch unchanged, no autostart. The next start (`replaceExternal` or `acquireExternal`) bumps epoch and aborts those ids; callers must acquire again. Adapter `start` receives per-slot `config.provenance` (`host-external` | `host-isolated-ios`) plus optional executable/environment — never a Session id. Dispose/last-release race start/stop against configured `cleanupTimeoutMs`. The dispose Promise settles after that budget. `closed` means admission is closed, not that work finished. `cleanupPending` covers unresolved Adapter start as well as late instance `stop`. Late `stop`/`start` failures after the settled Promise are retained on `lifecycle().cleanupFailures` and must not become unhandled rejections.

This subset does **not** extract live `PhoneDevices`, does **not** allocate listen ports, and does **not** prove Host SIGKILL containment. #574 remains open.

## Alternatives considered

**Same handle plus refcount for external joins.** Rejected: the first `release` would drop every joiner.

**Adapter `stop(slot)`.** Rejected: a late old start would kill a replacement.

**N Cordis `PhoneDevices` as the product pool.** Rejected: two generation owners.

**Await Adapter start without a budget on Host dispose.** Rejected: an Adapter that ignores `signal` would pin Host teardown.

## Consequences

The Host-alive external occupancy core supports cancel-with-siblings, failed-start cleanup, and bounded dispose. Fake adapters exercise these obligations; two separate external pools using `stageFake` exercise independent generations, not isolated generations within one pool. Isolation remains unavailable until a private provider exists. Native descendant membership after Host death, bounded loopback port allocation, and migrating `PhoneDevices` onto this adapter remain unmet.

## Testing

`runtime-pool.spec.ts` covers distinct external handles, cancelled sibling `PHONE_ABORTED` without awaiting start, failed start then retry, dispose admission `closed` with `cleanupPending` through unresolved start and late `stop`, late cleanup failures on `lifecycle().cleanupFailures`, replace invalidation, `stopExternal` without autostart, memoized dispose, last-release/dispose cleanup budgets, orthogonal stop failures, isolated `PHONE_UNAVAILABLE`, and two fake external generations without a silent fallback.

## Related

Fleet Service ownership remains [the mobilecli provider note](../feature/2026-08-27-phone-runtime-mobilecli-provider.md). Missing-binary composition remains [the unresolved-binary note](../bug-fix/2026-08-30-phone-runtime-unresolved-mobilecli.md).
