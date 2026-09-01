# @deepseek-ai/dsh-phone-environment-android

English | [中文](README.zh.md)

Android platform Provider for `ctx.phoneEnvironment`. It detects a compatible writable Android SDK from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the Host default, or the `sdkmanager` path. Reuse requires working `sdkmanager` 12+, `avdmanager`, and the `pixel_6` device definition; an obsolete or broken installation falls back to `$DSH_HOME/phone/android/sdk`. The default AVD always lives under `$DSH_HOME/phone/android/avd`, and child-only environment entries expose both roots to mobilecli without changing the user's `PATH`.

The managed command-line tools manifest pins Google build `15859902` for macOS arm64/x64, Windows x64, and Linux x64 with the exact download URL, byte length, and SHA-256 digest. Preparation installs the fixed `platform-tools`, `emulator`, and `system-images;android-35;google_apis;<host ABI>` package ids through `sdkmanager`, then creates `Pixel_6_API_35_Gestalt` through `avdmanager`. Apple silicon uses `arm64-v8a`; supported x64 Hosts use `x86_64`. Windows and Linux arm64 report unsupported because Google does not publish the required Host toolchains.

Preparation requires a `licenseAccepted: true` request after the settings page displays the Google source, download facts, 16 GB free-space requirement, SDK root, AVD identity, and [Android SDK License](https://developer.android.com/studio/terms). The Provider never accepts the license during detection. The command-line tools request requires `Accept-Encoding: identity`; final validation uses the received decoded byte count and SHA-256 instead of treating a compressed response's `Content-Length` as the asset length. Download and extraction use an owner-only staging directory and a `cmdline-tools/`-only ZIP root. The private AVD output is removed before creation and again after cancellation or failure, so a partial prior attempt cannot block retry. A failed or cancelled operation publishes no ready state; installed SDK packages remain resumable.

Preparation installs the SDK and private AVD without starting it. The Provider runs `emulator -accel-check` before every explicit start. Windows Hypervisor Platform and BIOS virtualization, Linux KVM installation and group membership, and unavailable macOS virtualization are `manual-required` states. USB developer mode, USB debugging, RSA trust, and OEM Windows drivers also remain manual. A product-started Emulator process is owned until disable, cancellation, or plugin teardown reaches process exit; an unexpected process exit revokes running readiness immediately. Stop is bounded, shared by concurrent lifecycle callers, and reports a failed Windows process-tree termination instead of claiming quiescence.

## Config

| Field | Default | Meaning |
|---|---|---|
| `root` | `$DSH_HOME/phone` | Private phone environment root containing the managed Android SDK and AVD home. |

Preparation failures use stable `PHONE_ANDROID_*` codes for license, download, length, digest, archive, SDK packages, AVD creation, boot timeout, cancellation, unsupported Hosts, and process failures. The Host projects them through the full revisioned `/phone/environment` snapshot.

## Model Experience

Indirectly, through `dsh-tool-phone`. A running Android environment restarts the selected mobilecli generation with the managed SDK/AVD environment, requires that generation to list the emulator online, and recognizes a syntactically valid Annex-B key access unit containing linked SPS, PPS, and IDR slice headers before publishing ready. This Host probe does not decode pixels; final acceptance separately requires a real picture in the GUI. Start, reactivation, listing, and capture share one cancellation owner, so disable, cancellation, and teardown cannot publish stale running readiness. The GUI and model-facing `device_*` tools therefore address the same verified emulator.

#### KV Cache effect

None until `dsh-tool-phone` exposes deferred phone schemas to a model request.

## Known Limitations and Deferred Work

- Google SDK packages remain upstream downloads and are not bundled or rehosted by Desktop.
- Windows hypervisor enablement, Linux KVM permissions, BIOS virtualization, USB debugging, RSA trust, and OEM drivers require the user or administrator.
- The final release acceptance requires a real API 35 download, H264 picture, GUI control, and real-model `device_act`; fixture evidence does not satisfy it.
