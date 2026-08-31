# @deepseek-ai/dsh-phone-runtime

English | [中文](README.zh.md)

The phone device fleet Service over one external [mobilecli](https://github.com/mobile-next/mobilecli) server: the package spawns `mobilecli server start --listen 127.0.0.1:<serverPort>` as a child process, polls its HTTP JSON-RPC endpoint (methods per the upstream [OpenRPC specification](https://github.com/mobile-next/mobile-openrpc/blob/main/mobilecli/openrpc.md)), and publishes the unified Android/iOS device listing on `ctx.phoneDevices`. Service Definition and Provider are folded into one package while mobilecli is the only backend; the deferred model Consumer lives in [`dsh-tool-phone`](../tool-phone/README.md) and imports only this package.

- `listDevices(signal?)` — fresh grouped listing `{ android, ios: { simulators, reals } }`; every entry is a frozen `PhoneDeviceRef` (`id` branded `DeviceId`, `name`, `kind: 'emulator' | 'simulator' | 'real'`, `platform`, `state` verbatim, `online`). Offline emulators and simulators are included because they are valid boot targets; the query always sends `includeOffline: true`. `online` is true only for the upstream `online` state, and every other upstream state — `offline`, `unauthorized`, and the rest — is carried verbatim on `state` instead of folding into it, so an `unauthorized` handset stays distinguishable in the listing while upstream refuses its io until the trust prompt is accepted. The `devices.list` result is accepted in both shipped shapes — the bare device array and mobilecli 1.0.5's `{ devices: [...] }` envelope — and duplicate upstream entries are kept verbatim.
- `boot(id, signal?)` / `shutdown(id, signal?)` — upstream `device.boot` / `device.shutdown`, addressed by the branded id. Physical handsets are refused locally with `PHONE_REAL_DEVICE` before any RPC (upstream restricts both verbs to simulators/emulators), and ids absent from the latest published listing fail with `PHONE_DEVICE_NOT_FOUND`. A successful mutation schedules an immediate refresh poll.
- `io(request, signal?)` — upstream `device.io.tap` / `gesture` / `text` / `button`. Physical handsets are valid targets; only ids absent from the latest published listing fail locally with `PHONE_DEVICE_NOT_FOUND`.
- `startCapture(request)` — upstream `device.screencapture`. `h264` maps onto upstream `avc`; the returned `PhoneCaptureStream` is an unread body whose `contentType` is the upstream header. Both answer shapes are accepted: the bare stream, and mobilecli 1.0.5's `{ format, sessionUrl }` envelope, whose session URL is resolved against the server origin and forced back onto the loopback fence before the stream opens. `requestTimeoutMs` bounds only the wait for response headers; the caller owns body cancellation. Ids absent from the latest published listing fail with `PHONE_DEVICE_NOT_FOUND`.
- `agentStatus(id, signal?)` / `installAgent(id, options?)` — the iOS real-device link, driven by one-shot `agent status` / `agent install` child runs of the same executable. Installs are idempotent: without `force`, a status probe answers an already-installed agent without any install spawn, and `reinstalled` names a forced run. Real handsets re-sign through the configured `provisioningProfilePath` (the upstream command requires it for real iOS installs). Every answer about an installed, re-signed real handset carries `FREE_SIGNING_PROFILE_REMINDER`, the proactive notice that free-team profiles expire after 7 days and that `installAgent(id, { force: true })` is the re-run entry.
- `onChanged(sub)` — disposer-returning subscription; each committed `PhoneDeviceChange` carries the complete new listing plus the `added`/`removed` id arrays against the previously published one. Delivery is synchronous after the committing poll, a throwing subscriber is contained and logged, and notifications never outlive the Service.

All operations accept an optional `AbortSignal` and enforce validated time ceilings; every failure normalizes onto `PhoneDevicesError` (`PHONE_DISPOSED`, `PHONE_ABORTED`, `PHONE_TIMEOUT`, `PHONE_UNAVAILABLE`, `PHONE_UNRESOLVED`, `PHONE_PROTOCOL`, `PHONE_UPSTREAM`, `PHONE_DEVICE_NOT_FOUND`, `PHONE_REAL_DEVICE`, `PHONE_REAL_DEVICE_ISSUE`). A `PHONE_REAL_DEVICE_ISSUE` failure carries the structured arm on `issue` — `device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, or `device-unplugged` — classified from the upstream output of both the agent commands and the JSON-RPC error messages; upstream `-32010` stays `PHONE_DEVICE_NOT_FOUND` so Host 404 semantics survive.

## Config

| Field | Default | Meaning |
|---|---|---|
| `executablePath` | — | Absolute or cwd-relative override; when absent, `PATH` is searched first, then npm-global, the npx cache, and `npm_config_prefix`. An Electron-minimal PATH also probes `/opt/homebrew/bin` and `/usr/local/bin`. |
| `serverPort` | `12000` | Loopback port passed as `--listen 127.0.0.1:<port>`; mirrors the upstream default. |
| `pollIntervalMs` | `5000` | Health-probe and device-poll cadence. |
| `readyTimeoutMs` | `60000` | Total window for the first readiness probe; exceeded readiness fails the plugin loudly. |
| `requestTimeoutMs` | `30000` | Ceiling per JSON-RPC round trip other than boot; mirrors the upstream RPC timeout. |
| `bootTimeoutMs` | `180000` | Ceiling for `device.boot`; mirrors the upstream extended write deadline for slow boots. |
| `agentTimeoutMs` | `120000` | Ceiling on one `agent status` / `agent install` child run. |
| `provisioningProfilePath` | — | `.mobileprovision` passed as `--provisioning-profile` when installing or re-signing the agent on a real handset (required upstream for real iOS installs); when set, the path must name an existing file. |

## Extension points

A missing or unusable mobilecli still activates the Service; `listDevices`, `boot`, `shutdown`, `io`, `startCapture`, and the agent verbs then reject with `PHONE_UNRESOLVED` and install guidance (`npm install -g mobilecli@latest`; no Homebrew formula exists upstream). The Host stays up. The package also exports a `./invariant` companion that must ride every real Service generation and validates that every change notification names exactly the difference its own listing has versus the published one.

## Model Experience

Indirectly, through dsh-tool-phone, which renders every listing, observation, mutation, action, and screenshot fact.

#### KV Cache effect

Independent of model requests: the Service spawns a local mobilecli child, polls device state, and notifies Host-side consumers only; nothing it publishes enters a session log or model context, so prefix reuse and cache behavior are untouched.

## Known Limitations and Deferred Work

- **External FSL-1.1-Apache-2.0 dependency edge** — mobilecli is executed, never vendored or copied; its binaries stay outside this repository, so behavior follows whatever version the user installed and this package pins nothing.
- **Loopback only** — the spawned server is always bound to `127.0.0.1:<serverPort>`; remote device fleets behind a mobilecli server on another host are out of scope.
- **User preinstall required** — without a user-installed mobilecli the Service stays composed and every operation rejects with `PHONE_UNRESOLVED` (by design); no auto-download, no Homebrew formula exists upstream, and Android support additionally needs `adb` in PATH while iOS simulators need Xcode Command Line Tools.
- **Real-iPhone coverage is opt-in** — the hardware-in-the-loop suite runs only when `DSH_PHONE_REAL_UDID` names a connected handset (and `DSH_PHONE_REAL_PROFILE` its provisioning profile); every other host self-skips it, so CI pins the real-device link only against the fake mobilecli double. The on-device agent artifacts are downloaded by mobilecli itself during `agent install`, never by this package, and iOS device tunnels stay owned by the mobilecli server — a failed tunnel surfaces only through the structured `tunnel-failed` arm.
- **Windows npm-shim gap** — native Windows suites exercise the production resolver and process lifecycle through a test-owned `fakemobilecli.exe` symlink to the current Node executable. npm-global `.cmd` shims remain unverified; `executablePath` should name a native `mobilecli.exe` until the process owners support batch shims.
