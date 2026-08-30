# Agent Note: mobilecli phone device fleet Service

Status: implemented

English | [中文](2026-08-27-phone-runtime-mobilecli-provider.zh.md)

## Problem

The mobile device dock (#355) needs a Host-side answer to "what phone hardware exists and how do I boot or shut a device down". The Host already speaks Browser over a swappable seam, but phones had nothing: raw `adb`/`xcrun` scripting in consumers would fork per-OS device logic into every caller, and a direct-adb shortcut would hard-wire Android's transport into the Host.

## Decision

`packages/phone/phone-runtime` (@deepseek-ai/dsh-phone-runtime) is the phone device fleet Service on `ctx.phoneDevices`, folding Service Definition and Service Provider into one package because mobilecli is the only conceivable backend today ([capability seams](../../../../docs/glossary.md#capability-seam) allow the fold; Consumers still live elsewhere). The Service:

- spawns the user-installed `mobilecli` as `server start --listen 127.0.0.1:<serverPort>` with the credential-scrubbed parent environment — never vendors, copies, or shells out to adb; every device fact crosses the upstream OpenRPC JSON-RPC contract (`devices.list`, `device.boot`, `device.shutdown`, `server.info`, plus Consumer-facing `device.io.*` and `device.screencapture`);
- probes readiness (`server.info`), then polls `devices.list` with `includeOffline: true` so shutdown simulators stay visible boot targets; `online` maps from the upstream `state` field, `kind` from the upstream `type` field (`emulator`/`simulator`/`real`, anything else is a loud `PHONE_PROTOCOL`);
- publishes grouped listings `{ android, ios: { simulators, reals } }` only on a real difference and notifies `onChanged` subscribers with the exact added/removed id delta, enforced at runtime by the package's invariant companion (pre-publication recompute against the published listing);
- refuses `boot`/`shutdown` on physical handsets locally before any RPC, mirroring the upstream simulator-only restriction;
- fails loud at every stage after activation: an unresolvable binary still activates the Service and every operation then rejects with `PHONE_UNRESOLVED` plus install guidance (`npm install -g mobilecli@latest`; no brew formula exists upstream) instead of killing Host composition ([graceful missing-binary](../bug-fix/2026-08-30-phone-runtime-unresolved-mobilecli.md)); pre-ready child death rejects plugin initialization; post-ready loss (exit, refused socket, protocol breach, invariant breach) marks the Service lost so later operations reject with the recorded reason.

Deployment-varying knobs are validated Config fields (`executablePath`, `serverPort` — upstream default 12000, `pollIntervalMs`, `readyTimeoutMs`, `requestTimeoutMs` — upstream RPC timeout, `bootTimeoutMs` — the upstream extended boot deadline). All operations fuse the caller's `AbortSignal` with these ceilings and normalize every failure onto the closed `PhoneErrorCode` union carried by `PhoneDevicesError`.

## Alternatives considered

**Direct adb/xcrun integration in the Host.** Rejected: it re-implements mobilecli's device aggregation (per-OS transports, state normalization, remote fleets) and hard-wires Android tooling into Host code the dock would have to fork again for iOS.

**Split Definition/Provider packages now.** Rejected as premature: with exactly one backend, the split only duplicates the manifest/tsconfig boilerplate the seam note warns about; the `ctx.phoneDevices` key and vocabulary already isolate Consumers from the fold.

**Silently empty composition without mobilecli.** Rejected: a silently empty device list is worse than a loud install error; the package's value is trustworthy fleet truth, and "no binary" is a deployment mistake an operator must see. Composition itself no longer throws — see [the unresolved-binary note](../bug-fix/2026-08-30-phone-runtime-unresolved-mobilecli.md) — because killing the Host for an optional provider hides the guidance.

## Consequences

The deferred Consumer [`dsh-tool-phone`](2026-08-28-tool-phone-deferred-device-tools.md) gets one branded-id surface for both platforms and can boot/shutdown simulators with change notifications, but they inherit a hard user prerequisite: mobilecli must be installed (npm/source only) and its platform prerequisites (adb, Xcode CLT) must be present. `io` and `startCapture` are additive Service methods for Host Consumers such as [the same-origin stream channel](../architecture/2026-08-28-phone-same-origin-stream-channel.md); they do not change listing or lifecycle semantics. The external dependency stays FSL-1.1-Apache-2.0 at arm's length — executed, never vendored — so behavior tracks the installed version; the package pins only the OpenRPC method names and wire shapes it validates. Suites run keyless against a scripted `fakemobilecli` JSON-RPC double; its single staging authority emits an extensionless POSIX executable or a Windows `fakemobilecli.exe` symlink to the current Node executable over the same fake module, so native Windows coverage exercises the production resolver, process owners, and lifecycle assertions without a production-only test path.
