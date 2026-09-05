# Agent Note: Phone-stream Android logicalDisplay route fixtures

Status: implemented

English | [中文](2026-09-05-phone-stream-android-logical-route-fixtures.zh.md)

## Problem

Phone-stream route tests mint Android captures and forward tap JSON-RPC with decoded `captureWidth`/`captureHeight`. After Android capture-source IO requires a current `logicalDisplay`, those tests fail when the listing fixture leaves dumpsys unset. Landscape listing sizes can also start Host `adb screenrecord` if `openAndroidSystemH264` is not mocked.

## Decision

`packages/phone/phone-stream/tests/routes.spec.ts` still mocks `readAndroidLogicalDisplay` to `undefined` by default. The tap JSON-RPC case sets `{ width: 100, height: 200 }` to match the decoded 100×200 source. The live capture-size case sets `{ width: 2868, height: 1320 }` and keeps asserting Host `io` saw those decoded extents. A declared `vi.mock` of `android-h264-process.ts` returns `buildGradientH264()` so landscape listing never launches host `adb`. Production code is unchanged.

## Alternatives considered

**Cast into PhoneDevices private `readAndroidLogicalDisplay`.** Rejected: the module mock is the same seam production listing uses.

**Leave dumpsys undefined and expect PHONE_PROTOCOL.** Rejected: these tests prove WebSocket forwarding of decoded capture fields, not missing-logical refusal.

## Consequences

Baseline feature stays green when dumpsys is absent except the two decorated cases. After backend merge, the same fixtures supply compatible aspect so capture IO is admitted without changing the decoded-wire assertion.
