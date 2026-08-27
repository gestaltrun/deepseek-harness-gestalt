# Agent Note: Reject Legacy Pairing Transaction Formats

Status: implemented

English | [中文](2026-08-27-reject-legacy-pairing-transaction-formats.zh.md)

## Problem

The pre-release pairing-state decoder accepted unversioned and version-1 documents after version 2 became the sole writer format. That permanent recovery path let stale durable authority bypass the repository rule that pre-release backends reject old formats and retained cleanup reconstruction that no current producer needs.

## Decision

A missing store value still creates an empty pairing transaction state. Every present pairing transaction document must carry `formatVersion: 2`; missing, version-1, and unknown versions throw before any authority field is decoded. The runtime contains no legacy replay recovery or delimiter-key decoder. This decision partially supersedes the version-1 migration behavior in [Keep Pairing State and Desktop Access in One PostgreSQL Transaction](../bug-fix/2026-08-25-postgres-pairing-transaction-encoding-and-access.md).

## Alternatives considered

**Keep legacy decoding until the first tagged release.** Rejected because the pre-release format rule already requires old documents to fail, and an open-ended runtime compatibility path has no removal event.

**Reset an old document to empty state.** Rejected because silently deleting Personal Pairing, Relay, and attachment authority would turn a format error into data loss.

**Run migration inside the decoder.** Rejected because the operated state completed a version-2 write before this restriction; any remaining old document is a deployment data error that must stop the release and receive an explicit operator action.

## Consequences

The pairing codec has one durable format and substantially less recovery code. A remaining old production row fails loud instead of silently migrating or losing authority, so candidate acceptance stops until the operator proves or performs the required data repair.

## Testing

Codec coverage proves that version 2 round-trips, while a version-1 or unversioned document is rejected before field decoding. Existing PostgreSQL transaction coverage continues to prove atomic pairing-state and Desktop access commits.
