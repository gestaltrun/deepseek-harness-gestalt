# Agent Note: Use complete-link pairing for controlled Mobile release acceptance

Status: implemented

English | [中文](2026-08-28-link-only-mobile-release-acceptance.zh.md)

## Problem

The controlled Mobile release attestation required both camera QR scanning and complete-link pairing even though both inputs enter the same invitation parser and pairing handshake. The release operator selected the complete-link path for phone acceptance and excluded camera hardware from the controlled run. Keeping `camera-pairing` in the exact evidence vocabulary would require a false claim before signing.

## Decision

`COMPANION_RELEASE_FLOWS` requires `link-pairing` and does not include `camera-pairing`. Operated acceptance uses the complete invitation link on Android Emulator and iOS Simulator. Camera QR scanning remains a supported product capability with its existing component and lifecycle coverage, but it is not evidence required by `Mobile Companion Acceptance` or Mobile signing authorization.

## Alternatives considered

**Report complete-link acceptance as camera acceptance.** Rejected because immutable release evidence must name the flow that actually ran.

**Require both pairing inputs for every controlled release.** Rejected because the inputs share the same parser and handshake while camera permission and hardware add a separate device condition outside this release scope.

**Remove camera scanning from the product.** Rejected because the operator narrowed release evidence, not the supported product capability.

## Consequences

The exact release vocabulary rejects `camera-pairing` as unknown and still rejects evidence missing `link-pairing`. Existing candidate-bound attestations are not reusable for a new candidate. Product camera behavior, permissions, cleanup, and tests remain unchanged. Release comments and issue acceptance must distinguish the supported camera feature from the link-only operated run.
