# Agent Note: Keep Native Mobile Release Evidence Fail-Closed

Status: implemented

English | [中文](2026-08-25-native-mobile-release-evidence-fails-closed.zh.md)

## Problem

The Android Snow proof runner allowed only ten seconds for a report after launching an existing Emulator. A cold application process could spend longer binding and initializing WebView, so the runner stopped it before `onCreate` wrote even the first progress record. Separately, Android release packaging fell back to `jarsigner` when `apksigner` was absent from `PATH`. A valid v2-only APK appears unsigned to `jarsigner`, which prints that result but exits successfully, so the packaging script could report success without proving an Android APK signature.

## Decision

The Android WebView proof allows thirty seconds for a cold-start report, matching the iOS WKWebView report deadline. It still fails when no report or progress appears by that deadline and always releases the disposable proof application.

Android release packaging accepts only the Android SDK `apksigner` as signature authority. It resolves the executable from `PATH`, `ANDROID_SDK_ROOT`, `ANDROID_HOME`, or Gradle's checked local `sdk.dir`, selects the newest available build-tools version, and fails when no verifier exists. `jarsigner` is not an APK signature verifier and is never a fallback.

## Alternatives considered

**Keep the ten-second Android deadline.** Rejected because process and WebView cold start are outside the proof implementation and can exceed that interval on an otherwise healthy Emulator.

**Increase the deadline without a bounded failure.** Rejected because a missing report must remain a deterministic release failure rather than an unbounded wait.

**Accept `jarsigner` exit status.** Rejected because it does not validate APK Signature Scheme v2 or later and can return success after stating that the APK is unsigned.

## Consequences

Cold native startup no longer creates a false Snow-proof failure, while a stalled runner still fails within a bounded interval. Android release jobs cannot claim a signed artifact unless the Android SDK validates its APK signature schemes. Local and CI packaging use the same verifier discovery rules.

## Testing

Runner coverage proves that a report arriving after twenty seconds succeeds within the thirty-second deadline while preserving all cleanup failure cases. Release coverage prevents a `jarsigner` fallback, and the complete local release script verifies a v2-signed APK with the discovered Android SDK `apksigner`.
