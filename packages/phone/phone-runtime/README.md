# @deepseek-ai/dsh-phone-runtime

English | [中文](README.zh.md)

The phone device fleet Service over one external [mobilecli](https://github.com/mobile-next/mobilecli) server: the package spawns `mobilecli server start --listen 127.0.0.1:<serverPort>` as a child process, polls its HTTP JSON-RPC endpoint (methods per the upstream [OpenRPC specification](https://github.com/mobile-next/mobile-openrpc/blob/main/mobilecli/openrpc.md)), and publishes the unified Android/iOS device listing on `ctx.phoneDevices`. Service Definition and Provider are folded into one package while mobilecli is the only backend; a future Consumer (tool or GUI) lives in its own package and imports only this one.

- `listDevices(signal?)` — fresh grouped listing `{ android, ios: { simulators, reals } }`; every entry is a frozen `PhoneDeviceRef` (`id` branded `DeviceId`, `name`, `kind: 'emulator' | 'simulator' | 'real'`, `online`). Offline emulators and simulators are included because they are valid boot targets; the query always sends `includeOffline: true`, and `online` is true only for the upstream `online` state (`offline`, `unauthorized`, and other states read false).
- `boot(id, signal?)` / `shutdown(id, signal?)` — upstream `device.boot` / `device.shutdown`, addressed by the branded id. Physical handsets are refused locally with `PHONE_REAL_DEVICE` before any RPC (upstream restricts both verbs to simulators/emulators), and ids absent from the latest published listing fail with `PHONE_DEVICE_NOT_FOUND`. A successful mutation schedules an immediate refresh poll.
- `io(request, signal?)` — upstream `device.io.tap` / `gesture` / `text` / `button`. Physical handsets are valid targets; only ids absent from the latest published listing fail locally with `PHONE_DEVICE_NOT_FOUND`.
- `startCapture(request)` — upstream `device.screencapture`. `h264` maps onto upstream `avc`; the returned `PhoneCaptureStream` is an unread body whose `contentType` is the upstream header. `requestTimeoutMs` bounds only the wait for response headers; the caller owns body cancellation. Ids absent from the latest published listing fail with `PHONE_DEVICE_NOT_FOUND`.
- `onChanged(sub)` — disposer-returning subscription; each committed `PhoneDeviceChange` carries the complete new listing plus the `added`/`removed` id arrays against the previously published one. Delivery is synchronous after the committing poll, a throwing subscriber is contained and logged, and notifications never outlive the Service.

All operations accept an optional `AbortSignal` and enforce validated time ceilings; every failure normalizes onto `PhoneDevicesError` (`PHONE_DISPOSED`, `PHONE_ABORTED`, `PHONE_TIMEOUT`, `PHONE_UNAVAILABLE`, `PHONE_UNRESOLVED`, `PHONE_PROTOCOL`, `PHONE_UPSTREAM`, `PHONE_DEVICE_NOT_FOUND`, `PHONE_REAL_DEVICE`).

## Config

| Field | Default | Meaning |
|---|---|---|
| `executablePath` | — | Absolute or cwd-relative override; when absent, each `PATH` directory is probed for `mobilecli`. |
| `serverPort` | `12000` | Loopback port passed as `--listen 127.0.0.1:<port>`; mirrors the upstream default. |
| `pollIntervalMs` | `5000` | Health-probe and device-poll cadence. |
| `readyTimeoutMs` | `60000` | Total window for the first readiness probe; exceeded readiness fails the plugin loudly. |
| `requestTimeoutMs` | `30000` | Ceiling per JSON-RPC round trip other than boot; mirrors the upstream RPC timeout. |
| `bootTimeoutMs` | `180000` | Ceiling for `device.boot`; mirrors the upstream extended write deadline for slow boots. |

## Extension points

A missing or unusable mobilecli fails composition loudly with install guidance (`npm install -g mobilecli@latest`; no Homebrew formula exists upstream); nothing degrades silently. The package also exports a `./invariant` companion that must ride every real Service generation and validates that every change notification names exactly the difference its own listing has versus the published one.

## Model Experience

None, as this package is a pure Host-side device fleet service that registers no prompt, tool schema, or other model-visible surface.

#### KV Cache effect

Independent of model requests: the Service spawns a local mobilecli child, polls device state, and notifies Host-side consumers only; nothing it publishes enters a session log or model context, so prefix reuse and cache behavior are untouched.

## Known Limitations and Deferred Work

- **External FSL-1.1-Apache-2.0 dependency edge** — mobilecli is executed, never vendored or copied; its binaries stay outside this repository, so behavior follows whatever version the user installed and this package pins nothing.
- **Loopback only** — the spawned server is always bound to `127.0.0.1:<serverPort>`; remote device fleets behind a mobilecli server on another host are out of scope.
- **User preinstall required** — without a user-installed mobilecli the Service refuses to compose (by design); no auto-download, no Homebrew formula exists upstream, and Android support additionally needs `adb` in PATH while iOS simulators need Xcode Command Line Tools.
- **No Windows coverage** — the mobilecli shim scenarios in this package's suites are POSIX-only, and Windows npm-global `.cmd` shims are untested; point `executablePath` at a native `mobilecli.exe` and treat Windows as unverified until suites cover it.
