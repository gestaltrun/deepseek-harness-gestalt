# Agent Note: Keep Pairing State and Desktop Access in One PostgreSQL Transaction

Status: implemented

English | [中文](2026-08-25-postgres-pairing-transaction-encoding-and-access.zh.md)

## Problem

The endpoint access-generation map used an in-memory `accountId\0desktopInstallationId` key and serialized that key directly into PostgreSQL `jsonb`. PostgreSQL rejects JSON strings containing the NUL escape, so a real Desktop Mobile Access enable failed before its state could commit. Desktop route changes also used pool-level queries while pairing state used a checked-out transaction client, allowing one half of a transition to survive when the final pairing-state commit failed.

## Decision

Pairing transaction format version 2 encodes each endpoint access-generation key as a two-element `[accountId, desktopInstallationId]` tuple and reconstructs the private NUL-delimited in-memory key only after parsing both branded values. The decoder accepts only version 2; [legacy pairing transaction formats fail loud](../simplification/2026-08-27-reject-legacy-pairing-transaction-formats.md).

`runPairingTransaction` supplies a transaction-bound `PersonalPairingAccessTransaction` beside the mutable pairing state. The PostgreSQL implementation routes Desktop access reads and writes through the same checked-out client, while the memory implementation supplies its serialized store. Provider transitions that change endpoint access use only this transaction-bound face.

## Alternatives considered

**Replace the separator with another string character.** Rejected because Account and Installation identifiers do not define an escaping scheme for an arbitrary delimiter, while a structured tuple preserves both values without inventing one.

**Keep Desktop access writes on the pool and compensate after rollback.** Rejected because a failed or indeterminate final commit cannot safely prove which half became durable; one database transaction already owns both authorities.

**Store the composite key as a single encoded blob.** Rejected because the branded components are ordinary bounded text and a JSON tuple remains directly inspectable and independently validated.

## Consequences

Operated PostgreSQL accepts endpoint access generations without NUL errors, and a failed final commit rolls back both the pairing document and Desktop route state. Callers that need Desktop access outside a pairing transition retain the public store methods, but provider transitions cannot escape the transaction-bound face.

## Testing

Codec coverage rejects NUL-bearing persistence output and round-trips version 2. PostgreSQL coverage injects a final `COMMIT` failure and observes both pairing state and Desktop access rolled back. The operated two-instance Platform accepted a real Desktop Mobile Access enable after writing version 2.
