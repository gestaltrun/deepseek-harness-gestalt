# @deepseek-ai/dsh-phone-environment

English | [中文](README.zh.md)

Host-owned phone toolchain state on `ctx.phoneEnvironment`. The Service publishes one immutable full snapshot for the Phone Devices settings client and keeps its identity while the enable gate or active mobilecli generation changes. The shared runtime state is a closed missing / downloading / verifying / activating / ready / failed union. Android and iOS preparation use separate extensible states; a non-macOS host reports iOS as unsupported instead of offering an operation it cannot execute.

The managed runtime is pinned to the six official mobile-next/mobilecli 1.0.5 GitHub Release archives for macOS, Windows, and Linux on arm64 and amd64. The package manifest records each exact URL, byte length, SHA-256 digest, and archive executable name. Runtime selection uses explicit operator override, managed current, then system discovery. It never writes a global npm installation or `PATH`.

mobilecli is licensed under FSL-1.1 with an Apache-2.0 future license. A runtime download directly from the upstream release is not a copy inside the Desktop Bundle, but product release remains blocked until counsel or the upstream licensor confirms that the intended product use is permitted. The package does not vendor or redistribute mobilecli.

## Model Experience

This Service adds no prompt or tool schema. Once a ready generation is enabled, the separate `dsh-tool-phone` Consumer may register its deferred `device_*` tools.

#### KV Cache effect

None while the runtime is missing or disabled. Deferred phone schemas enter a request only after tool discovery under `dsh-tool-phone`.

## Known Limitations and Deferred Work

- Android SDK and emulator preparation belongs to the platform-specific Android environment package.
- iOS runtime and simulator preparation belongs to the macOS-only iOS environment package.
- FSL-1.1 product-use clearance remains a Desktop release blocker.
