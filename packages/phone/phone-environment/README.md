# @deepseek-ai/dsh-phone-environment

English | [中文](README.zh.md)

Host-owned phone toolchain state on `ctx.phoneEnvironment`. The Service publishes one immutable full snapshot for the Phone Devices settings client and keeps its identity while the enable gate or active mobilecli generation changes. The shared runtime state is a closed missing / downloading / verifying / activating / ready / failed union. Android and iOS preparation use separate extensible states. A Host-owned one-click iOS preparation marks its `checking` state with `operation: 'prepare'`; passive detection omits the marker. A non-macOS host reports that iOS Simulator and physical iPhone control require macOS with a complete Xcode installation instead of offering operations it cannot execute.

The managed runtime is pinned to the six official mobile-next/mobilecli 1.0.5 GitHub Release archives for macOS, Windows, and Linux on arm64 and amd64. The package manifest records each exact URL, byte length, SHA-256 digest, and archive executable name. Preparation follows only the official GitHub asset redirect, streams into an owner-only staging directory, checks length and SHA-256, accepts exactly one root executable from the zip, probes `mobilecli --version`, and atomically replaces `current.json`. A failed or cancelled attempt removes staging and leaves the prior current generation usable. Runtime selection uses explicit operator override, managed current, then system discovery. It never writes a global npm installation or `PATH`.

The Host exposes the full snapshot at `GET /phone/environment` and trusted runtime/platform POST operations below that path through the shared same-origin trust fence. Platform Providers register into this stable Service; [the Android Provider](../phone-environment-android/README.md) contributes SDK, AVD, and Emulator preparation, while [the iOS Provider](../phone-environment-ios/README.md) contributes Xcode Runtime and Simulator preparation on macOS. Desktop composes the environment, Providers, `phone-runtime`, `phone-stream`, and `tool-phone` on every start. The stable fleet waits for this Service to select an executable; enabling activates it in place, while disabling cancels preparation and stops owned platform and runtime children. Settings publishes Android platform readiness after an online mobilecli listing plus a recognizable H264 key picture, and iOS Simulator readiness after an online listing plus a recognizable MJPEG/JPEG picture. These picture probes do not control model tool registration, which follows enabled fleet runtime readiness and performs authoritative device listing at invocation time.

mobilecli is licensed under FSL-1.1 with an Apache-2.0 future license. A runtime download directly from the upstream release is not a copy inside the Desktop Bundle, but product release remains blocked until counsel or the upstream licensor confirms that the intended product use is permitted. The package does not vendor or redistribute mobilecli.

## Config

| Field | Default | Meaning |
|---|---|---|
| `root` | `$DSH_HOME/phone` | Private managed installation root containing staging directories, immutable versions, and `current.json`. |
| `executablePath` | — | Operator-owned executable override. It remains authoritative over managed and system candidates, and managed preparation rejects with `PHONE_ENVIRONMENT_OVERRIDE` while configured. |

Preparation rejects concurrent calls with `PHONE_ENVIRONMENT_BUSY`; cancellation uses `PHONE_ENVIRONMENT_ABORTED`. Download trust failures use `PHONE_ENVIRONMENT_DOWNLOAD`, `PHONE_ENVIRONMENT_LENGTH`, or `PHONE_ENVIRONMENT_DIGEST`; archive, version, current-pointer, and filesystem failures use `PHONE_ENVIRONMENT_ARCHIVE`, `PHONE_ENVIRONMENT_VERSION`, `PHONE_ENVIRONMENT_CURRENT`, or `PHONE_ENVIRONMENT_DISK`. Activation and unexpected runtime loss use `PHONE_ENVIRONMENT_ACTIVATION` and `PHONE_ENVIRONMENT_RUNTIME_LOST`. Failed detection or preparation never silently selects a lower-precedence candidate or leaves the prior child and tools active.

## Model Experience

Indirectly, through `dsh-tool-phone`, which registers deferred `device_*` tools only when an enabled runtime generation is ready.

#### KV Cache effect

None while the runtime is missing or disabled. Deferred phone schemas enter a request only after tool discovery under `dsh-tool-phone`.

## Known Limitations and Deferred Work

- Apple license acceptance, first-launch authorization, Apple ID, system permissions, real-device trust, Developer Mode, signing identities, and provisioning profiles remain manual.
- FSL-1.1 product-use clearance remains a Desktop release blocker.
