# Agent Note: Foreground-only Companion synchronization

Status: implemented

English | [中文](2026-08-22-foreground-only-companion-synchronization.zh.md)

## Problem

A background alert could tell a person that a Desktop approval, question, completion, or failure needs attention, but the repository had only protocol records, token lifecycle, provider adapters, quotas, and tests rather than a shipped native delivery path. Keeping that dormant capability imposed credential, persistence, privacy, revocation, compatibility, and operational obligations. Notification state could also become stale before a person acted, so it could never authorize a Desktop mutation.

## Decision

Mobile Companion learns current state only after the user opens or foregrounds the application. Backgrounding stops the Relay WSS connection. Foregrounding reconnects with the selected Paired Desktop. Every acknowledged physical attachment starts one Mobile synchronization generation; connection loss and transport errors clear `socketOpen`, `synchronized`, and the active generation before internal reconnect. Relay ciphertext cannot mark synchronization complete: the authenticated Encrypted Companion decoder owned by #217 must decode a supported versioned Desktop resync message and call the generation-bound receiver returned by `bindValidatedDesktopResync`. A stale receiver cannot authorize a replacement socket. `companionMayMutate` then enables Session creation, prompts, cancellation, approvals, human-question answers, attachments, and other mutations; every helper and the final transmission controller fail closed before that point.

The product contains no push-delivery capability. APNs and FCM adapters, payload records, registration tokens, persistence, revocation cleanup, quotas, metrics categories, deployment secrets, native dependencies, HTTP operations, and notification deep links are absent from shipped source and configuration. Pairing links remain because they carry one short-lived Pairing Challenge and no stale interaction authority.

The repository-level `verify-companion-no-push` gate scans shipped application, tracked build configuration, package, example, native, Python, website, workflow, script, generated, manifest, and dependency-lock paths while excluding tests, prose, and known generated outputs. It rejects provider symbols and operations, singular and plural device-token fields, token repositories, native notification dependencies, permissions and APIs, vendor-native asset filenames, and obsolete release evidence while allowing ordinary array `push()` calls. Mobile lifecycle and mutation tests prove background stop, serialized foreground and internal reconnect, stale-generation rejection, raw-ciphertext rejection, fail-closed mutation paths, and grant removal on unpair. The shipped `main.tsx` and keyless snapshot call the same `mountMobileEntry` composition, which owns the `MobileCompanionSurface` supplied to the shared Web components. The snapshot retains a previously authenticated Session across a physical reconnect and pins create, prompt, cancel, attachment, approval, and Ask User controls as disabled before validated current-generation resynchronization.

This decision implements the notification-removal slice of the [real Companion product path](../../proposed/architecture/2026-08-22-real-companion-product-path.md). The earlier content-free notification decision is consolidated here because no production schema, configuration, migration, compatibility behavior, documentation promise, or supported-behavior test remains.

## Alternatives considered

**Keep dormant adapters and protocol records.** Rejected because unused schemas, token stores, quotas, provider payloads, and secret names would keep an unsupported capability and its privacy and operational obligations alive.

**Remove vendor adapters but preserve token and hint compatibility.** Rejected because no released Mobile product depends on those formats, and the pre-release repository does not promise compatibility for an unshipped path. Partial removal would preserve the broadest security-sensitive surfaces without delivering an alert.

**Keep a separate `ctx.remotePush` capability.** Rejected because a generic Platform notification bus would split token and delivery lifecycle from the owning Remote Access route and revocation lifecycle. With the product capability removed, a dormant service seam would preserve unsupported schemas and ownership rather than deepen a live module.

**Keep vendor payload builders in Mobile.** Rejected because APNs and FCM payloads are emitted by provider infrastructure, not by a backgrounded Mobile process. Mobile ownership would neither create a deliverable provider path nor remove provider access and privacy obligations; after removing push, no product layer owns vendor payload construction.

**Keep WSS alive or run silent synchronization in the background.** Rejected because mobile operating systems do not provide a dependable background execution contract for this product. Foreground reconnection gives one explicit lifecycle owner and current Desktop authority.

**Let a notification action settle an interaction.** Rejected because an approval or question may have changed after the notification was created. Every mutation must observe current Desktop state after authenticated synchronization.

## Consequences

Mobile Companion cannot alert a backgrounded phone. A person must open or foreground the application before learning current Desktop state. In exchange, Platform stores no device notification token, requires no mobile-notification provider credential, and owns no delivery quota, payload, or failure telemetry.

Reintroducing background alerts requires a new product decision with a real iOS and Android delivery path, explicit provider privacy and retention rules, deployment-owned credentials, token revocation semantics, stale-interaction protections, native lifecycle evidence, and an update to the absence gate. Background delivery still cannot grant mutation authority.
