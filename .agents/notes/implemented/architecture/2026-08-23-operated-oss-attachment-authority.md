# Agent Note: Operated OSS attachment authority

Status: implemented

English | [中文](2026-08-23-operated-oss-attachment-authority.zh.md)

## Problem

Remote attachment ciphertext shared by two production Platform instances cannot stay in process memory or in a PostgreSQL bytea row. The operated path needs private object storage, one-time pairing authority, bounded cleanup, temporary credentials, and a deploy check that does not overwrite lifecycle rules belonging to other bucket consumers.

## Decision

PostgreSQL is the capability authority and Alibaba Cloud OSS is the ciphertext byte store. `remote_attachment_objects` binds the deployment database identity and SHA-256 capability digest to a branded Personal Pairing id, a prefix-bound private object key, byte length, and expiry. Publishing writes a private OSS object before committing metadata. Inspect reads without consuming. Consume, revoke, and expiry cleanup commit metadata removal before best-effort object deletion, so a network failure cannot restore capability authority or hold a database transaction open. Durable rows reject malformed digests, pairing ids, object keys, lengths, and expiries before any object read.

The client accepts only an Alibaba Cloud OSS hostname, the deployment bucket and object prefix, and an `ecs-ram-role/<role>` selector. It obtains temporary credentials through ECS IMDSv2, uses HTTPS and Signature V4, requests private object ACL, and exposes no public URL or long-lived access key. Platform Deploy runs the image's lifecycle preflight before replacing the running container. The preflight preserves unrelated rules and ensures one enabled one-day expiration rule for the exact attachment prefix; failure leaves the previous deployment running.

## Alternatives considered

**Store ciphertext in PostgreSQL.** Rejected because PostgreSQL owns compact transaction authority, while large encrypted objects have independent transfer and cleanup behavior.

**Put permanent Alibaba Cloud access keys in GitHub Secrets.** Rejected because the ECS RAM role supplies short-lived credentials without a long-lived deploy secret.

**Let each Platform startup rewrite the bucket lifecycle.** Rejected because a runtime instance should not need bucket-administration authority during every restart, and startup races could overwrite unrelated rules. Deployment owns the idempotent lifecycle merge.

## Consequences

Both Platform instances can publish, inspect, consume, and revoke through one PostgreSQL authority and one private OSS namespace. A capability is one-time even when consumers race across instances. Direct cleanup normally removes ciphertext immediately; the prefix-scoped one-day rule bounds orphan retention after an OSS deletion failure. Deployment requires the ECS role to read and update lifecycle configuration in addition to private object operations.

## Testing

`oss-client.spec.ts` pins IMDSv2, temporary credential validation, private object headers, lifecycle preservation, exact-rule idempotence, and missing-lifecycle creation. `oss-attachment-store.spec.ts` rejects malformed durable rows before OSS reads. `product-entry-durable.spec.ts` drives two stores against disposable PostgreSQL with shared OSS bytes, pairing isolation, capacity, concurrent one-time consume, expiry cleanup, and the exact boot entry; `production-env.spec.ts` pins deployment variables and workflow projection.
