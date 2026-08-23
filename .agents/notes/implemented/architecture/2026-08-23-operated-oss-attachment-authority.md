# Agent Note: Operated OSS attachment authority

Status: implemented

English | [中文](2026-08-23-operated-oss-attachment-authority.zh.md)

## Problem

Remote attachment ciphertext shared by two production Platform instances cannot remain in process memory or depend only on PostgreSQL bytea rows. The operated path needs private object storage, one-time pairing authority, rolling compatibility with existing `remote_attachment_blobs` rows, Account-complete quotas, bounded active cleanup, temporary credentials, and a deploy check that does not overwrite lifecycle rules belonging to other bucket consumers.

## Decision

PostgreSQL is the capability authority and Alibaba Cloud OSS is the ciphertext byte store. `remote_attachment_objects` binds the deployment database identity and SHA-256 capability digest to a branded Personal Pairing id, a prefix-bound private object key, byte length, expiry, Account quota reservation, compatibility ownership, and an exclusive consume claim. Publishing commits `remote_attachment_publish_intents` before writing OSS and atomically replaces the intent with object and compatibility metadata. An indeterminate final commit retains the object whenever PostgreSQL has the object row, the intent, or an unreadable outcome; expiry reconciliation deletes an orphan object and releases its branded quota reservation after a restart.

The additive migration keeps `remote_attachment_blobs` readable and adds one shared claim token. The PostgreSQL bridge and OSS store both claim that row before responding, so they may overlap after the non-atomic predecessor has been drained. The predecessor performs inspect, response write, and revoke as separate operations; no schema column can prevent it from returning bytes already inspected. Platform Deploy therefore requires two completed deployments: every host first enters `postgres` bridge mode through an all-candidate-ready contract, and a later invocation may enter `oss` mode only when every active predecessor reports `postgres`. The contract stops every predecessor before any replacement receives product traffic, and rollback restores only hosts whose predecessor was renamed.

The current Mobile Installation and confirmed pairing authorize each request. Upload requires a positive exact `Content-Length`, reserves Account-complete blob quota before reading the request body, and releases admission after a rejected or failed read. Metadata retains the opaque branded reservation id until consume, revoke, expiry, pairing revocation, or publish-intent recovery releases it. A periodic PostgreSQL sweep deletes only pairing ids that the authority explicitly returns from that sweep's candidate set, records durable quota-release work, and queues OSS deletion with configured concurrency. Publishing does not await queued object deletion, while disposal waits for the active sweep and cleanup workers. OSS lifecycle remains the backstop for object deletion failures. Durable reads reject malformed digests, pairing ids, object keys, lengths, expiries, claims, and reservation ids before buffering a single preallocated object buffer; every OSS stream failure destroys the stream.

The client accepts only an Alibaba Cloud OSS hostname, the deployment bucket and object prefix, and an `ecs-ram-role/<role>` selector. It obtains temporary credentials through ECS IMDSv2, uses HTTPS and Signature V4, requests private object ACL, and exposes no public URL or long-lived access key. Platform Deploy runs lifecycle preflight only for the OSS phase, starts and checks a candidate on every host without touching the active predecessor, then performs the global contract. Preflight or candidate failure leaves every predecessor running; replacement failure restores each renamed predecessor and never deletes an untouched host's container.

## Alternatives considered

**Keep PostgreSQL as the only ciphertext store.** Rejected because PostgreSQL owns compact transaction authority, while large encrypted objects have independent transfer and cleanup behavior. Duplicate `remote_attachment_blobs` ciphertext serves the rolling compatibility mechanism.

**Put permanent Alibaba Cloud access keys in GitHub Secrets.** Rejected because the ECS RAM role supplies short-lived credentials without a long-lived deploy secret.

**Let each Platform startup rewrite the bucket lifecycle.** Rejected because a runtime instance should not need bucket-administration authority during every restart, and startup races could overwrite unrelated rules. Deployment owns the idempotent lifecycle merge.

## Consequences

Both Platform instances can publish, inspect, consume, and revoke through one PostgreSQL authority and one private OSS namespace. A capability is one-time across bridge and OSS consumers after the predecessor drain. Active expiry and pairing-revocation cleanup bound metadata and quota retention to the configured sweep interval; direct cleanup normally removes ciphertext immediately, while the prefix-scoped one-day rule bounds orphan retention after an OSS deletion failure. Compatibility duplicates ciphertext in PostgreSQL until the OSS phase completes. Deployment requires an explicit `PLATFORM_REMOTE_ATTACHMENT_STORAGE`, two ordered workflow invocations, sweep and cleanup-concurrency values, and ECS role authority for the OSS phase.

## Testing

`oss-client.spec.ts` pins IMDSv2, temporary credential validation, private object headers, single-buffer bounded reads, stream destruction, lifecycle preservation, exact-rule idempotence, and missing-lifecycle creation. `oss-attachment-store.spec.ts` rejects malformed durable rows, preserves capacity errors during cleanup failure, and retains an object after an indeterminate commit. `product-entry-durable.spec.ts` uses disposable PostgreSQL to demonstrate the fixed-base inspect-write-revoke overlap, bridge-to-OSS claim exclusivity, candidate-only revocation, quiescent disposal, and publish-intent crash/restart reconciliation. `production-env.spec.ts` pins the two deployment modes, candidate readiness, contract ordering, and host-specific rollback.
