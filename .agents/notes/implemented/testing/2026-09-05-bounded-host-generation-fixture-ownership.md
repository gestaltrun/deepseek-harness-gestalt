# Agent Note: Bounded Host-generation fixture ownership

Status: implemented

English | [中文](2026-09-05-bounded-host-generation-fixture-ownership.zh.md)

## Problem

Desktop test infrastructure needs to model cleanup ownership for Host generations before production launch wiring is safe. A generation can have startup reservations, active leases, duplicate lease collisions, Host shutdown, and late settlement after a bounded deadline. Publishing ownership after a foreign callback or accepting caller-selected authority permits reentry and replacement races. Unbounded waits prevent shutdown, while eviction-based replay memory can accept an old request again.

The [Desktop phone Electron e2e lane](2026-08-31-desktop-phone-electron-e2e-lane.md) exercises launched processes and visible product behavior, but it does not own this private protocol decision. Issue #572 also requires hidden virtual-device operation, which remains outside this test-only policy.

## Decision

The test policy uses two deep Modules. The fixture cleanup owner accepts one opaque `OwnedFixtureLease`; an injected `FixtureCleanupDeadline` bounds `beginCleanup()` and Host stop independently. A prompt begin transfers sole remaining ownership to `FixtureCleanupContinuation.settled`; an expired or failed begin retains contained late-begin and continuation observation without holding cleanup. Host cleanup starts after that bounded begin outcome and aggregates with the fixture report in stable Host-then-fixture phase order. Success requires a mechanism-neutral verified-quiescence report with no issues.

The Host-generation owner accepts one bounded Host hello per exact channel object. Desktop mints the generation identifier and capability; Host cannot select or reuse them. Every later request echoes both values and remains bound to the original channel state. An unavailable support decision returns a correlated `PLATFORM_CONTAINMENT_UNAVAILABLE` result without teaching an operating-system mechanism through the protocol.

State and memoized Promises are published before foreign calls. `BrokerReservation.id` is published synchronously from `reserve()` before asynchronous startup. Per-lease-id admission tails serialize only same-identifier admission; unrelated identifiers do not head-of-line block. `request()` defers dispatch through `Promise.resolve().then`, so there is no global start barrier. A returned lease must match the reserved identifier; a mismatch fails closed and the unmatched lease is cleaned without generation ownership. Reservations exist before broker reservation and startup callbacks. Generation closure sets its fence and publishes its exact Promise before Host, reservation, collision, or lease cleanup begins. Duplicate lease admission publishes a collision record and cleanup Promise before invoking foreign cleanup. Disconnect, Host exit, and explicit cleanup use the same closure Promise.

Host, reservation, collision, and lease lanes settle independently through an injected deadline. Closure snapshots reservations, leases, collisions, replay refusals, and admission tails, then clears those generation-owned collections before foreign cleanup. A reservation claimed by close, or one whose `reserve()` returns after that clear, must not restore admission tails. `ownershipSnapshot()` reports the current reservation, lease, collision, and admission-tail counts. Prompt reservation settlement during closure enters the closure barrier; settlement after declared expiry enters one detached bounded cleanup lane. Late rejection and late cleanup issues have distinct exact-once diagnostics. Natural lease exit observation is independent from cleanup and has its own diagnostic.

Request replay memory has an injected positive capacity. Reaching it closes the generation instead of evicting an older request. Wire parsing validates exact fields, version, discriminants, and bounded values. Cleanup issues use typed phases and stable ordering.

These Modules launch no process and make no hard-containment claim. A production broker Adapter must independently establish its ownership and containment guarantees before any real fixture uses this policy. The hidden-window launch seam and product recovery behavior remain deferred to Issue #572.

## Alternatives considered

**Unbounded waits and unbounded tombstones.** Rejected because a stalled startup or cleanup can block Desktop shutdown, while permanent request history grows without limit. The deadline Adapter bounds ownership lanes, and replay-capacity exhaustion fails closed.

**External PID or process-group scans followed by group termination.** Rejected because external discovery and identifier reuse do not prove exact ownership. Process details remain inside a future reviewed broker Adapter rather than the policy Interface.

**Host-supplied generation or capability authority.** Rejected because caller-selected values can address an existing generation. Desktop mints both values after accepting one hello on the exact channel object.

**Publishing state after foreign callbacks.** Rejected because synchronous reentry can observe no reservation, collision, or closure Promise and start duplicate work. The policy publishes state and deferred Promises first.

**Visible automated Electron operation.** Rejected because Issue #572 requires automated virtual-device operation to remain hidden. This test policy neither launches Electron nor supplies visible acceptance evidence.

**Operating-system mechanism vocabulary in the outer Interface.** Rejected because the policy should express ownership, bounded settlement, and verified quiescence without promising a platform-specific containment implementation.

## Consequences

The fake-only tests pin authority minting, channel ownership, synchronous publication, bounded settlement, replay refusal, stable aggregation, and diagnostic ownership without invoking a real process. The policy constrains and informs a future production Adapter, but it does not prove that Adapter safe. Product wiring, hidden virtual-device launch, same-Host recovery, and real containment evidence remain required under Issue #572 before the production behavior is complete.
