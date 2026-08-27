# Agent Note: Consume One Installation Proof per Mobile Access Disable

Status: implemented

English | [中文](2026-08-26-mobile-access-disable-single-proof.zh.md)

## Problem

Disabling Mobile Access first persisted endpoint revocation intent and then committed the disable transition in a second pairing transaction. Both stages called Account authentication with the same request proof. Installation proofs are single-use, so the first stage consumed the proof and the second stage returned `PROOF_REPLAYED`; Desktop displayed HTTP 401 and restored the enabled state on its next poll.

## Decision

The disable request authenticates its Desktop Installation once before the two pairing transactions and reuses only the resulting Account and Installation identities in both stages. The durable revocation-intent transaction and the final disable transaction remain separate, and Mobile Access enablement retains its existing single transaction.

## Alternatives considered

**Authenticate independently in both transactions.** Rejected because the HTTP request carries one proof and Platform cannot create another proof without the Desktop Installation private key.

**Merge revocation intent and disablement into one transaction.** Rejected because the retained intent must precede external credential and route cleanup so an interrupted disable remains recoverable.

## Consequences

One Settings action consumes one proof while preserving the two-stage durable cleanup protocol. A failed first stage still consumes the request proof, so a retry remains a new authenticated request with a fresh proof.

## Testing

Provider coverage calls disable with an authenticated Desktop and proves Account authentication runs exactly once. The operated Desktop dev flow additionally toggles the real Settings switch through the production Platform.
