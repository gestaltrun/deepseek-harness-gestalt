# @deepseek-ai/dsh-phone-environment-ios

English | [中文](README.zh.md)

macOS platform Provider for `ctx.phoneEnvironment`. It reads the Host `process.platform`, the selected complete Xcode application, Xcode license and first-launch status, available iOS Simulator runtimes, iPhone device types, and Simulator inventory. Windows and Linux return a stable unavailable state without spawning an iOS command; iOS Simulator and iPhone control require macOS with Xcode.

Preparation is available only after the user installs or updates the complete Xcode application, accepts its license, and finishes first-launch components in Xcode. The Provider can run `xcodebuild -downloadPlatform iOS`, create the product-owned `DSH Gestalt iPhone` through `simctl`, and boot it. Xcode installation or update, Apple license acceptance, first-launch authorization, Apple ID, system permissions, real-device unlock and trust, Developer Mode, signing identity, and provisioning profiles remain manual requirements. Product UI calls the mobile component a device-control agent and does not promise one upstream implementation.

The Provider owns one command sequence at a time. Cancellation terminates the direct child process tree and restores the last actionable state. Disable or teardown waits for the active sequence and shuts down only a Simulator booted by this Provider; an already-running user Simulator remains user-owned. Cross-process `simctl` JSON is validated before it becomes a platform state.

Preparation failures use stable `PHONE_IOS_*` codes for unsupported Hosts, missing or incomplete Xcode, license and first-launch requirements, runtime download, Simulator creation or boot, invalid command output, cancellation, and process failures. The Host projects them through the full revisioned `/phone/environment` snapshot.

## Model Experience

Indirectly, through `dsh-tool-phone`. A running iOS environment restarts the selected mobilecli generation, requires that generation to list the exact Simulator online, and verifies a recognizable MJPEG/JPEG picture before publishing ready. mobilecli does not offer H264 for iOS Simulator; the GUI displays the actual MJPEG format through the shared real-stream fallback. The GUI and model-facing `device_*` tools therefore address the same verified Simulator.

#### KV Cache effect

None until `dsh-tool-phone` exposes deferred phone schemas to a model request.

## Known Limitations and Deferred Work

- Xcode and Apple platform assets remain Apple-controlled installations and downloads; Desktop does not bundle or rehost them.
- Apple license, first-launch authorization, Apple ID, system permissions, physical-device trust, Developer Mode, signing identity, and provisioning profiles require the user.
- The final release acceptance requires a real runtime download, Simulator boot, recognizable picture, GUI control, and real-model `device_act`; fixture evidence does not satisfy it.
