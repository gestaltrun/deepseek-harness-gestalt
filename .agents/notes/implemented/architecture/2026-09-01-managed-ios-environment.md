# Agent Note: Managed iOS environment

Status: implemented

English | [中文](2026-09-01-managed-ios-environment.zh.md)

## Problem

The Phone Devices settings page could list an existing iOS Simulator or physical iPhone but could not prepare Xcode's iOS runtime and a default Simulator. Command-copy instructions could not distinguish automatable Xcode operations from Apple authorization, signing, and device-trust steps that remain under user or operating-system authority.

## Decision

`phone-environment-ios` registers one platform Provider into the stable `phoneEnvironment` Service. The Host `process.platform` is authoritative: Windows and Linux publish a stable unavailable state and never run an iOS process. On macOS the Provider detects the selected complete Xcode application, license acceptance, first-launch components, available iOS runtimes, iPhone device types, and Simulator inventory.

The Provider runs `xcodebuild -downloadPlatform iOS` only after Xcode, license, and first-launch prerequisites are complete. It selects the newest available iOS runtime and iPhone device type, creates one `DSH Gestalt iPhone`, and boots it through `simctl`. One controller reserves the operation before its first asynchronous command. Cancellation restores the last actionable state, process exit facts remain independent, and disable or teardown shuts down only a Simulator that the Provider booted.

Xcode installation or update, Apple license acceptance, first-launch authorization, Apple ID, system permissions, physical-device unlock and trust, Developer Mode, signing identity, and provisioning profiles remain manual requirements. Product copy calls the phone-side component the device-control agent instead of promising an upstream internal implementation.

The stable Service publishes running readiness only after its current mobilecli generation lists the exact Simulator online and the common format-specific picture verifier recognizes an MJPEG/JPEG frame. mobilecli does not offer H264 for iOS Simulator, so the shared real-stream fallback displays the actual MJPEG format instead of manufacturing an H264 result. Browser and model-facing Consumers therefore share one committed readiness fact. The iOS environment depends on the Android readiness foundation and the real-stream fallback rather than duplicating either mechanism.

## Alternatives considered

**Install Xcode or accept Apple authorization from Desktop.** Rejected because the App Store distribution, license, administrator, account, device-trust, and signing decisions require Apple or user authority that this product does not own.

**Infer capability from browser platform strings.** Rejected because the Browser is not the process that executes Xcode and platform strings can be reduced, emulated, or forwarded. Host `process.platform` owns the fact.

**Publish ready after `simctl bootstatus`.** Rejected because a booted Simulator does not prove that the active mobilecli generation can list it or produce a picture for GUI and Agent Consumers.

**Require H264 from iOS Simulator.** Rejected because current mobilecli does not expose that format for Simulator capture. MJPEG/JPEG recognition and actual-format display preserve real capability without a false H264 claim.

**Shut down every matching Simulator on disable.** Rejected because an already-running Simulator may be owned by the user or another application. The Provider retains only the Simulator generation it booted.

## Consequences

The scheme-C settings page separates automatable runtime and Simulator preparation from Apple-controlled manual steps. Cross-platform fixtures cover every state without large downloads, while final acceptance still requires a real iOS runtime, list and boot, recognizable picture, GUI tap and Home, and a real-model `device_act` call. Physical iPhones continue through existing device-control-agent status and installation failures; this Provider does not claim that trust or signing is automatic.
