# Agent Note: Managed Android environment

Status: implemented

English | [中文](2026-09-01-managed-android-environment.zh.md)

## Problem

The Phone Devices settings page could detect existing mobilecli devices but could not prepare an Android SDK, system image, or AVD. Shell commands exposed provider details to users, did not establish download or license consent, and could not make a private SDK visible to the same mobilecli generation used by GUI and Agent Consumers.

## Decision

`phone-environment-android` registers one platform Provider into the stable `phoneEnvironment` Service. The Service owns the full revisioned snapshot and trusted HTTP operations; the Provider owns Android SDK discovery, downloads, package installation, the private default AVD, Emulator child processes, cancellation, and teardown. Unregistration restores the Android platform state to `deferred` without replacing the Service identity.

Compatible writable SDK roots are reused only after working `sdkmanager` 12+, `avdmanager`, and `pixel_6` definition probes. Otherwise the Provider uses `$DSH_HOME/phone/android/sdk`; its AVD home is always `$DSH_HOME/phone/android/avd`. The Provider contributes `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, and SDK tool directories only to the selected mobilecli child generation. The runtime Service applies the same child environment to its server and one-shot agent commands.

Google command-line tools build `15859902` is fixed by Host tuple with exact length and SHA-256. The package ids are `platform-tools`, `emulator`, and API 35 Google APIs with the Host CPU ABI. Preparation starts only after an explicit Android SDK license acceptance request and a 16 GB free-space check. `sdkmanager` owns upstream package download and license files; the Provider owns the verified command-line tools staging and the idempotent `Pixel_6_API_35_Gestalt` AVD.

Preparation installs the SDK and AVD without starting it. The Provider checks acceleration before an explicit AVD start. Windows Hypervisor Platform, Linux KVM permissions, BIOS virtualization, USB debugging, RSA trust, and OEM drivers remain manual requirements. Product-started Emulator process trees stop to quiescence on cancellation, disable, or teardown, and an unexpected process exit revokes readiness. A running platform state carries a branded emulator id, causes mobilecli to reactivate with the Android environment, and becomes ready only after mobilecli lists that id online and yields a syntactically valid Annex-B key access unit whose SPS, PPS, and IDR slice headers reference one another. This Host probe does not decode pixels; real-picture GUI acceptance remains a separate release requirement. Start, reactivation, listing, and capture share one cancellation owner.

## Alternatives considered

**Keep command-copy instructions.** Rejected because users asked for product-owned preparation, and copied commands cannot preserve download trust, explicit license consent, lifecycle ownership, or a shared mobilecli environment.

**Always install a private SDK.** Rejected because a compatible writable Android Studio or SDK installation already carries large immutable packages that do not need duplication.

**Modify the user's PATH or shell profile.** Rejected because the Android toolchain belongs to one Desktop runtime generation and must not change unrelated terminals or applications.

**Automate hypervisor, KVM, USB trust, and OEM drivers.** Rejected because these actions require administrator, firmware, device, or operating-system authority that Desktop does not own.

## Consequences

The scheme-C settings page displays Android and iOS as independent platform cards below the shared mobilecli runtime. Android preparation exposes its source, fixed tool build, SDK root, AVD identity, disk requirement, license consent, progress, manual requirements, and retry state. Package and Electron fixtures verify deterministic layout and lifecycle behavior, while release acceptance still requires the official downloads, a real API 35 boot, real H264, GUI control, and a real-model tool call.
