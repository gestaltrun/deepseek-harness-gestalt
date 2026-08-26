# Agent Note: Keep Mobile Access Authority Actionable

Status: implemented

English | [中文](2026-08-27-mobile-access-authority-actionability.zh.md)

## Problem

Desktop Relay startup awaited physical WSS readiness while holding the lifecycle authority serial, so an unavailable attachment prevented Settings polling and new pairing challenges. Successful disablement retained local grants that had already been revoked at Platform. Mobile duplicate cleanup reached a revocation path that authenticated the same one-time Installation proof twice. The operated Relay omitted its PostgreSQL pairing-activity sink, so a working Mobile channel remained offline in Desktop Settings.

## Decision

Desktop lifecycle authority starts every required physical controller while serialized, releases the authority serial, and then awaits network readiness. A successful Mobile Access disable clears local active and pending grants only after Platform commits disablement. Pairing revocation authenticates once and reuses the resolved Account and Installation ids across its cleanup transactions. Mobile revocation of absent authority and cancellation of an absent endpoint challenge are idempotent. The operated Relay receives the shared PostgreSQL Personal Pairing authority as its Mobile presence sink.

## Alternatives considered

**Hold the authority serial until WSS readiness.** Rejected because network availability would continue to control whether Settings can create, cancel, or disable pairing authority.

**Erase local grants before Platform disablement.** Rejected because a failed remote commit would leave live authority without its local cleanup identity.

**Project online state from the Desktop socket.** Rejected because Mobile presence is the authenticated lease and can attach through either Platform instance.

**Retry `PROOF_REPLAYED` in the client.** Rejected because the server consumed one proof twice inside one request; a retry would hide that ownership error and perform another mutation attempt.

## Consequences

Settings synchronization, challenge creation, and disablement remain actionable while a Relay attachment is unavailable. Re-enabling Mobile Access cannot restore locally retained authority that Platform revoked. One authenticated Mobile attachment updates durable lease-derived online state across both Platform instances, and repeat cleanup can converge after an interrupted or already-settled operation.

## Testing

Lifecycle coverage holds physical startup pending while authority synchronization completes. Desktop controller coverage disables and re-enables without restoring stale grants. Provider coverage proves endpoint cancellation is repeatable and Mobile revocation calls Account authentication once. Operated-composition coverage requires the PostgreSQL pairing activity sink.
