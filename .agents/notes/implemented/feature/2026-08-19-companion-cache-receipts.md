# Agent Note: Companion Cache and uncertain-operation settlement

Status: implemented

English | [中文](2026-08-19-companion-cache-receipts.zh.md)

## Problem

Issue #40 (part of #27): while Remote Offline, Mobile must keep showing last-confirmed Workspace/Session metadata and transcripts without giving them away at rest, must refuse every mutation, and must resolve mutations whose Desktop result was lost across a disconnect — without becoming an offline outbox that silently replays work. Clearing one Paired Desktop's cached content must not destroy the pairing keys that keep the pairing valid.

## Decision

**One settlement controller, no outbox.** `CompanionUncertainOperationSettlement` owns the entire uncertain-operation lifecycle: gating, capacity reservation, durable send fencing, receipt settlement, and reconciliation. `transmit` consults existing receipts before touching the transport: `unknown` throws until reconciliation, `committed` returns without resending, and an absent operation atomically reserves a `prepared` row before transport entry. Only terminal `committed` and `not-submitted` rows may be evicted for a future reservation; `prepared` and `unknown` remain non-evictable. The `CompanionMutationTransport` must await its `beforeSend` hook exactly once immediately before the first external send attempt. That hook durably changes the reservation to `unknown`, so any later success or failure remains reconcile-only even when the transport reports a definite send rejection. Failure before the hook deletes the reservation because no external send was permitted. Reconciliation is single-flight per controller, queries every unknown operation id once, and settles it to `committed` with Desktop's original result or `not-submitted` after explicit absence. There is no retry, queue, or replay path; the Relay only forwards ciphertext.

**Encryption keys derive through the Personal Pairing seam.** #31 is not done; the cache treats per-desktop AES-GCM keys as an injected `CompanionCacheKeySource`. Production wiring will derive cache keys from the pairing material #31 establishes; no pairing logic lives here. Each record carries a fresh random 12-byte IV, and `seal`/`open` bind `desktopId` plus content kind as AES-GCM AAD. `open` and `loadOpenedContent` select the key and AAD from the caller-supplied desktop id. IndexedDB reads parse `desktopId`, the 12-byte IV, ciphertext bytes, and branded receipt fields; `loadOpenedContent` rejects a row whose stored desktop id does not match the requested one.

**The exclusion list is an allowlist enforced at the cache boundary.** `companionCacheAdmits` admits exactly `workspace-metadata`, `session-metadata`, and `transcript`; everything else — attachment bytes, terminal content, spill files, credentials, and any unknown kind — stays out, and `CompanionCache.saveOpenedContent` fails loud on excluded kinds rather than silently skipping.

**Offline gating sits in the operation that makes the decision.** `transmit` refuses before touching the transport when Remote is Offline, for every mutation kind (prompt, cancel, approval, question, attachment, other); cache reads are unaffected because they never pass through the controller.

**Cache rows are account-scoped and live apart from pairing keys.** `IndexedDbCompanionCacheStore` requires `companionCacheDatabaseName(environment, accountId)` (`${accountStorageNamespace(environment, accountId)}:companion-cache`); there is no installation-global default, so account switch isolates caches and receipts. Pairing-key records use the pairing seam's own store under a different suffix. `clearDesktop` deletes only that desktop's rows in the cache database. `saveOpenedContent` caps plaintext UTF-8 bytes at `transcriptPageBytes` or `companionMessageBytes`; stores cap receipt count at `containerValues`.

**Protocol extension, not a new channel.** The `query-operation-status` operation and `status` results (committed-with-original, or explicit `absent`) extend the existing versioned Companion codec: a committed status embeds the confirmed result of the same operation id, an absent status is only `{ absent: true }`, and both markers cannot coexist. Desktop Companion adapters answer status queries; the Relay only forwards ciphertext. The codec and Mobile settlement ship here.

## Consequences

`CompanionCache`, `WebCryptoCompanionCacheCipher`, `IndexedDbCompanionCacheStore`, and `CompanionUncertainOperationSettlement` ship in `apps/mobile/src/companion-cache.ts` with pure gating helpers. The Companion codec carries `query-operation-status` and the two `status` results. Desktop Companion adapters answer status queries through the injected `CompanionMutationTransport`; cache encryption keys arrive through `CompanionCacheKeySource`. `apps/mobile/tests/companion-cache.spec.ts` proves ciphertext at rest, per-Desktop key and AAD separation, the exclusion list, byte and receipt ceilings, durable-row validation, account-namespace isolation, offline gating, the crash windows on both sides of the send fence, non-eviction across 257 concurrent reservations, single-flight reconciliation, and no automatic replay. `packages/platform/remote-protocol/tests/companion.spec.ts` proves the codec round-trips and rejects forged status answers, and the assembled keyless example (`examples/remote-protocol`) carries a reconnect status-query leg end to end through the Loader-booted snapshot.

## Alternatives considered

- **An offline outbox that replays uncertain operations on reconnect** — rejected: Desktop-authoritative mutations must never be re-sent on Mobile's own initiative; uncertainty resolves only by Desktop's answer per operation id.
- **A separate readiness/rollback state machine beside the controller** — rejected per the one-lifecycle-controller rule; durable send fencing and reconciliation are phases of the same operation.
- **Encrypting receipts too** — receipts carry only operation ids and settlement status, no opened content, so per-desktop AES-GCM protection targets the content rows that actually hold Workspace/Session data.
