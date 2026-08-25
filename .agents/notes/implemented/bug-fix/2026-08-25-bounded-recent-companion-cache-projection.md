# Agent Note: Bound Companion Cache to the Most Recent Opened Transcript

Status: implemented

English | [中文](2026-08-25-bounded-recent-companion-cache-projection.zh.md)

## Problem

The authenticated Mobile receiver retained every conversation opened during one process lifetime and saved the complete aggregate as one encrypted projection snapshot. Real provider context and several opened Sessions exceeded the 61,440-byte Companion Cache ceiling. Every later live projection retried and rejected the same oversized save, leaving Remote Offline on an older snapshot.

## Decision

The receiver keeps conversation map order equal to recent authenticated activity by moving each updated conversation to the end. Cache persistence retains complete Desktop, Workspace, and Session metadata plus only that most recent conversation. If the result still exceeds the projection-snapshot ceiling, persistence removes oldest conversation nodes until the exact versioned JSON fits and marks `hasMore`; if non-node state alone cannot fit, it stores the complete metadata without a transcript. The ordinary cache byte ceiling remains unchanged and is still enforced by `CompanionCache` before encryption.

## Alternatives considered

**Increase the projection-snapshot ceiling.** Rejected because cache retention would grow with model context and opened Sessions, while the existing bound limits storage, encryption work, and startup parsing.

**Keep the last successfully saved oversized predecessor.** Rejected because Remote Offline would silently present stale Session metadata after every later authenticated update.

**Cache every conversation in a separate unbounded row.** Rejected because Mobile needs one recently opened read-only transcript, not an offline replica of Desktop Session storage, and a row-per-Session policy would require a separate eviction authority.

## Consequences

Authenticated metadata continues advancing even after long real-provider transcripts. Remote Offline retains the latest active conversation tail when it fits and can request older history after synchronization returns. Cache encryption, Account and Personal Pairing isolation, excluded content kinds, and operation receipts are unchanged.

## Testing

The cache runtime regression saves two accumulated 35,000-character conversations under the existing ceiling, restores complete metadata, and retains only the recent Session. Receiver coverage continues to parse and publish conversation snapshots and live updates after recency reordering.
