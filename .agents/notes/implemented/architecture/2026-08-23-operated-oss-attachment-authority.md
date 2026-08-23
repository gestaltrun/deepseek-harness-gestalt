# Agent Note: Operated OSS attachment authority

Status: implemented

English | [中文](2026-08-23-operated-oss-attachment-authority.zh.md)

## Problem

Remote attachment ciphertext shared by two production Platform instances cannot remain in process memory or depend only on PostgreSQL bytea rows. The operated path needs private object storage, one-time pairing authority, rolling compatibility with existing `remote_attachment_blobs` rows, Account-complete quotas, bounded active cleanup, temporary credentials, and a deploy check that does not overwrite lifecycle rules belonging to other bucket consumers.

## Decision

PostgreSQL is the capability authority and Alibaba Cloud OSS is the ciphertext byte store. `remote_attachment_objects` binds the deployment database identity and SHA-256 capability digest to a branded Personal Pairing id, a prefix-bound private object key, byte length, expiry, Account quota reservation, rolling-compatibility ownership, and an exclusive consume claim. Publishing writes a private OSS object before committing metadata. A failed or indeterminate commit deletes the object only when PostgreSQL confirms that no metadata references it; otherwise lifecycle cleanup retains the safe fallback.

The additive migration keeps `remote_attachment_blobs` readable. New instances consume legacy-only rows and compatibility-write ciphertext beside new OSS metadata so an old instance can consume an upload created during a rolling deployment. The old row remains the compatibility authority until an exclusive new-instance consume removes it; an old-instance consume makes the paired OSS metadata stale and unusable. New-instance claims are committed before OSS reads, so concurrent HTTP consume requests across instances admit one response. A failed response restores an unexpired claim, while a finished response never replays even when later object or quota cleanup fails.

The current Mobile Installation and confirmed pairing authorize each request. Upload admission reserves the Account-complete blob quota before publish, and metadata retains the opaque reservation id until consume, revoke, expiry, or pairing revocation releases it. A periodic PostgreSQL sweep removes expired rows and rows whose confirmed pairing no longer exists, records durable quota-release work, and queues OSS deletion with configured concurrency. Publishing queues bulk cleanup without awaiting object deletion. OSS lifecycle remains the backstop for object deletion failures. Durable reads reject malformed digests, pairing ids, object keys, lengths, expiries, claims, and reservation ids before any object stream is buffered; an exact `Content-Length` check and streaming byte counter enforce the PostgreSQL length authority.

The client accepts only an Alibaba Cloud OSS hostname, the deployment bucket and object prefix, and an `ecs-ram-role/<role>` selector. It obtains temporary credentials through ECS IMDSv2, uses HTTPS and Signature V4, requests private object ACL, and exposes no public URL or long-lived access key. Platform Deploy runs the image's lifecycle preflight under fail-fast shell semantics before replacing the running container. The preflight preserves unrelated rules and ensures one enabled one-day expiration rule for the exact attachment prefix; failure leaves the previous deployment running.

## Alternatives considered

**Keep PostgreSQL as the only ciphertext store.** Rejected because PostgreSQL owns compact transaction authority, while large encrypted objects have independent transfer and cleanup behavior. Duplicate `remote_attachment_blobs` ciphertext serves the rolling compatibility mechanism.

**Put permanent Alibaba Cloud access keys in GitHub Secrets.** Rejected because the ECS RAM role supplies short-lived credentials without a long-lived deploy secret.

**Let each Platform startup rewrite the bucket lifecycle.** Rejected because a runtime instance should not need bucket-administration authority during every restart, and startup races could overwrite unrelated rules. Deployment owns the idempotent lifecycle merge.

## Consequences

Both Platform instances can publish, inspect, consume, and revoke through one PostgreSQL authority and one private OSS namespace. A capability is one-time even when consumers race across instances, and an existing binary remains compatible during replacement. Active expiry and pairing-revocation cleanup bound metadata and quota retention to the configured sweep interval; direct cleanup normally removes ciphertext immediately, while the prefix-scoped one-day rule bounds orphan retention after an OSS deletion failure. The rolling compatibility row duplicates ciphertext in PostgreSQL. Deployment requires sweep and cleanup-concurrency values, plus ECS role authority to read and update lifecycle configuration and private objects.

## Testing

`oss-client.spec.ts` pins IMDSv2, temporary credential validation, private object headers, bounded stream reads, lifecycle preservation, exact-rule idempotence, and missing-lifecycle creation. `oss-attachment-store.spec.ts` rejects malformed durable rows before OSS reads and retains an object after an indeterminate commit. `product-entry-durable.spec.ts` drives old and new stores against disposable PostgreSQL with shared OSS bytes, cross-instance claim exclusivity, rolling reads, pairing isolation, capacity, active expiry and revocation cleanup, quota release, non-blocking bulk deletion, and the exact boot entry. `production-env.spec.ts` pins deployment variables and fail-fast workflow projection.
