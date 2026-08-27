# Agent Note: Bound Companion Projections by Encoded Bytes

Status: implemented

English | [中文](2026-08-27-companion-surface-byte-pagination.zh.md)

## Problem

Fixed Session and history row ceilings did not bound the encoded size of Companion projections. Real Session titles, working directories, Workspace metadata, and tool output could make an otherwise valid browse or conversation snapshot exceed the projection byte ceiling, causing the Desktop endpoint to close the encrypted channel before Mobile received stable state.

## Decision

Desktop retains the authoritative Session and Workspace snapshot for the complete discovery. For each requested offset, it parses at most the row ceiling and selects the largest leading Session prefix whose complete projection envelope fits the protocol byte ceiling. Workspace membership is recalculated for each candidate prefix. The continuation cursor advances by the number of Session rows actually transmitted. If one Session and its Workspace metadata cannot fit, Desktop returns a bounded Host-wire failure instead of emitting an oversized projection. Conversation snapshots use the negotiated channel's exact encoder, discard only the oldest complete nodes until the newest suffix fits, and set `hasMore`. When the newest node alone is too large, Desktop retains that node and truncates only user-visible `text`, `argsRaw`, and error `message` fields by UTF-8 bytes.

## Alternatives considered

**Raise the projection byte ceiling.** Rejected because ciphertext, Relay frame, and endpoint memory limits are protocol safety controls rather than deployment tunables.

**Truncate titles, paths, or Workspace metadata.** Rejected because discovery fields are authoritative product data and silent truncation would make identity and navigation ambiguous.

**Drop Workspace rows before Session rows.** Rejected because Workspace membership is part of the browse projection and must remain exact for every transmitted Session.

## Consequences

Large real Host surfaces remain discoverable over multiple bounded projections without channel churn, skipped Sessions, or duplicate Sessions. Large conversations retain their most recent actionable content instead of forcing repeated reconnects, while older content remains reachable through history pagination. Page sizes vary with encoded content, so consumers must use returned continuation state rather than assume a fixed row count.

## Testing

Desktop product coverage projects a surface that exceeds 48 KiB at the row ceiling, verifies the first encoded envelope stays within the limit, and verifies the next page continues at the exact transmitted count without gaps. Relay coverage passes an oversized conversation through the real Companion encoder and verifies that the encrypted output retains its newest node, reports older history, and remains within 48 KiB.
