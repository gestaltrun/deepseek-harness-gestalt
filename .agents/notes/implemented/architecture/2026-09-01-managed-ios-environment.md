# Agent Note: Managed iOS environment

Status: implemented

English | [中文](2026-09-01-managed-ios-environment.zh.md)

## Problem

The Phone Devices settings page could list an existing iOS Simulator or physical iPhone but could not prepare Xcode's iOS runtime and a default Simulator. Command-copy instructions could not distinguish automatable Xcode operations from Apple authorization, signing, and device-trust steps that remain under user or operating-system authority.

## Decision

`phone-environment-ios` registers one platform Provider into the stable `phoneEnvironment` Service. The Host `process.platform` is authoritative: Windows and Linux publish dedicated unavailable content stating that iOS Simulator and physical iPhone control require macOS with a complete Xcode installation, offer no preparation components or operations, and never run an iOS process. On macOS the Provider detects the selected complete Xcode application, license acceptance, first-launch components, available iOS runtimes, iPhone device types, and Simulator inventory.

The Provider runs `xcodebuild -downloadPlatform iOS` only after Xcode, license, and first-launch prerequisites are complete. It selects the newest available iOS runtime and iPhone device type, creates one `DSH Gestalt iPhone`, and boots it through `simctl`. One controller reserves the operation before its first notification or asynchronous command. Cancellation restores the last actionable state, and timeout, signal, exit-code, termination-error, and output-overflow facts remain independent. Simulator JSON uses a one-megabyte fail-loud ceiling so ordinary `simctl` inventories are retained in full. Disable or teardown shuts down only a Simulator that the Provider successfully booted, retains ownership until shutdown succeeds, and preserves the running fact for an externally booted Simulator.

Xcode installation or update, Apple license acceptance, first-launch authorization, Apple ID, system permissions, physical-device unlock and trust, Developer Mode, signing identity, and provisioning profiles remain manual requirements. Product copy calls the phone-side component the device-control agent instead of promising an upstream internal implementation. The same-origin Phone Consumer detects that agent before minting an iOS real-device picture session and exposes status, install, and force-reinstall operations. The wire preserves every `PHONE_REAL_DEVICE_ISSUE` arm; an absent `provisioningProfilePath` has its own configuration-required state rather than collapsing into unavailable. Agent installation is the sole primary action, while detection remains secondary.

The stable Service publishes running platform readiness only after its current mobilecli generation lists the exact Simulator online, idempotently installs the device agent, and the common format-specific picture verifier recognizes an MJPEG/JPEG frame. This transaction also owns a running Simulator discovered during Provider registration, enable reconciliation, or manual refresh; cancellation publishes a retryable terminal state and cannot promote the Provider snapshot directly. The Host snapshot marks `checking` with `operation: 'prepare'` only while the one-click iOS preparation transaction owns the operation, so Settings offers cancellation without presenting passive refresh as cancellable. Candidate discovery and one-click mobilecli preparation reconcile the same unverified running fact after activation, including the order where a booted Simulator is observed before mobilecli exists. mobilecli does not offer H264 for iOS Simulator, so the shared real-stream fallback displays the actual MJPEG format instead of manufacturing an H264 result. This picture fact controls Settings readiness, while model tool registration follows enabled fleet runtime readiness and each invocation uses the live fleet list. The iOS environment depends on the Android readiness foundation and the real-stream fallback rather than duplicating either mechanism.

The Browser keeps pulling full Host snapshots while any runtime or platform lane is transient, and stops at a terminal state. This covers Host startup activation that begins before the Settings subscriber exists. The runtime owns `mobilecli server start` as a process tree rather than a direct child: npm's Node launcher may spawn the native server, and replacement or teardown must terminate both before another generation binds the configured loopback port. One-shot `agent status` and `agent install` commands use the same process-tree owner so cancellation reaches the native descendant before returning.

The GUI and Agent coordinate vocabulary stays in capture pixels on both platforms. Android forwards those pixels unchanged. XCTest consumes logical points, so the first iOS tap or swipe reads the official `device.info.screenSize`, validates its positive finite width, height, and scale, caches that size for the mobilecli generation, and converts every tap or swipe `x`/`y` coordinate before forwarding. Landscape versus portrait WDA bounds follow the live capture surface ([exact rotation](../bug-fix/2026-09-04-ios-semantic-input-rotation.md)). Generation replacement clears the cache. A missing or malformed iOS screen size fails as `PHONE_PROTOCOL` instead of returning a successful no-op.

## Alternatives considered

**Install Xcode or accept Apple authorization from Desktop.** Rejected because the App Store distribution, license, administrator, account, device-trust, and signing decisions require Apple or user authority that this product does not own.

**Infer capability from browser platform strings.** Rejected because the Browser is not the process that executes Xcode and platform strings can be reduced, emulated, or forwarded. Host `process.platform` owns the fact.

**Publish ready after `simctl bootstatus`.** Rejected because a booted Simulator does not prove that the active mobilecli generation can list it or produce a picture for GUI and Agent Consumers.

**Require H264 from iOS Simulator.** Rejected because current mobilecli does not expose that format for Simulator capture. MJPEG/JPEG recognition and actual-format display preserve real capability without a false H264 claim.

**Shut down every matching Simulator on disable.** Rejected because an already-running Simulator may be owned by the user or another application. The Provider retains only the Simulator generation it booted.

## Consequences

The scheme-C settings page separates automatable runtime and Simulator preparation from Apple-controlled manual steps. Cross-platform fixtures cover every state without large downloads, while final acceptance still requires a real iOS runtime, list and boot, recognizable picture, a visibly effective GUI tap and Home, and a real-model `device_act` call. Physical iPhones receive an actionable missing-agent state before picture load, can install or reinstall through the product, and resume the same GUI and Agent control path after a picture becomes available. Unlock, trust, signing, and provisioning remain explicit user prerequisites.
