# Agent Note: Android redetect keeps the managed SDK; verify failure keeps the fleet

Status: implemented

English | [中文](2026-09-03-android-redetect-managed-sdk-and-verify-keeps-fleet.zh.md)

## Problem

「重新检测」 after a successful Android preparation reported the SDK missing. `AndroidEnvironmentManager` discovery consulted only `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the Host default locations, and the `PATH` `sdkmanager` entry; it never probed the private managed root `$DSH_HOME/phone/android/sdk`, so the SDK it had itself installed was invisible to redetection.

A failed Android runtime verification deactivated the whole mobilecli fleet through `ctx.phoneDevices.deactivate()`. Verification failure is a device-level condition, but the teardown dropped the healthy runtime, and the settings card then rendered 未找到 mobilecli for a fleet that was still prepared. The single 15 s `ANDROID_RUNTIME_VERIFY_MS` also covered both the online-listing check and the H264 probe, so a cold Emulator boot that mobilecli had not yet listed online failed verification before the picture probe ever ran.

## Decision

`refresh` probes the managed root from disk when environment and `PATH` discovery miss: the plan reports `sdkSource: 'managed'` with components read from disk, so redetecting a prepared installation stays `ready` with `running: false`. A Host-managed SDK needs no compatibility re-probe because preparation pinned its own toolchain.

`activateAndroidRuntime` failure stops only the Android Provider's owned emulator through `this.android.deactivate()`; the activated fleet stays ready and the runtime snapshot keeps `kind: 'ready'`. `verifyAndroidRuntime` splits its budgets: a bounded online-listing wait polls `listDevices` every second under the configurable `androidRuntimeVerifyTimeoutMs` ceiling (default 180000 ms) before `startCapture`, while the recognizable-frame probe keeps the 15 s `ANDROID_RUNTIME_VERIFY_MS` budget and the 4 MB byte cap.

The settings-card listing source takes a `runtimeReady` face over the Host runtime snapshot: a `PHONE_UNRESOLVED` fleet pull renders the mobilecli-missing row only while the runtime is not ready; with a ready runtime the pull falls to the platform-neutral no-device recovery, because a ready snapshot proves the fleet is active and the resolution failure is stale.

## Alternatives considered

**Re-prepare the SDK after every redetect miss.** Rejected: the managed root is on disk and complete; re-downloading the pinned tools to fix a discovery gap is self-inflicted churn.

**Keep deactivating the fleet on Android verify failure.** Rejected: the failure names the device, not mobilecli; dropping the fleet punishes a healthy runtime and surfaces a false mobilecli-missing row.

**Stretch the single verification budget past 15 s.** Rejected: it would couple cold-boot listing variance to the H264 frame probe, which needs a short budget once the device is online.

**Treat every `PHONE_UNRESOLVED` pull as mobilecli-missing.** Rejected: with a ready runtime snapshot the fleet is provably active, so the row would direct the user to re-prepare a working installation.

## Consequences

Redetection is idempotent for the managed SDK, and one failed readiness commit costs only the emulator, not the fleet. Cold boots get up to three minutes to appear in the listing; a device that never comes online still fails with `PHONE_ANDROID_RUNTIME_VERIFY`, now under the operator-tunable ceiling. Tests pin the managed-root redetect, the fleet-preserving verify failure, the online-before-H264 ordering under fake timers, and the ready-runtime `PHONE_UNRESOLVED` fallback.
