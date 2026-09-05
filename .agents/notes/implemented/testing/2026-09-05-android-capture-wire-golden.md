# Agent Note: Keyless Host golden for Android capture-source IO

Status: implemented

English | [中文](2026-09-05-android-capture-wire-golden.zh.md)

## Problem

Android capture-source taps stay on the decoded plane while `dumpsys display` `logicalFrame` can be a uniform upsample of that plane. Package unit tests can pin `upstreamIo()` math, but they do not boot the assembled Host: Loader, `phone-runtime`, `phone-stream`, signed capture GET, and `/phone/ws/io`. The deferred-phone session snapshot only drives `device_act` as `{ kind: 'fresh-probe' }` against a fake fleet that drops the request, so it cannot refuse a wrong-plane browser tap.

## Decision

`examples/phone-capture-wire` is a declared `pnpm run test:snapshot` scenario. Source mode launches `@deepseek-ai/dsh-phone-capture-wire-demo` `src/bin.ts` through tsx; `DSH_EXAMPLE_MODE=lib` launches that package's `lib/bin.js` under plain Node with no tsx and no tsconfig paths. `pnpm run build` recreates `lib/bin.js` from `src/bin.ts`; the artifact is gitignored. Both bins boot the same `cordis.yml` through `dsh-app-boot`: `host-webserver`, a test-only staged `PhoneDevices` mount on fakemobilecli, and `phone-stream`. The snapshot writes synthetic `adb` and Annex-B bytes into an owned temp `ANDROID_SDK_ROOT/platform-tools` and prepends that directory onto PATH, so dumpsys and screenrecord never launch a device SDK binary. The scenario plugin mints a session, reads `GET /phone/devices` and requires `logicalDisplay` `2248×1080`, holds the signed H264 GET open, then sends two JSON-RPC taps with `captureRotation: 0` on the same grant. Stdout projects only mint `captureId`, capture `token`, and `expiresAt`; JSON-RPC error code and message stay literal so a missing-bounds failure cannot match the aspect-mismatch golden. Numeric planes and fakemobilecli `device.io.*` rows stay literal. IO WebSocket open and reply are bounded and listeners are removed on every path.

On the feature SHA without Host capture-to-logical mapping, the wrong-plane arm is accepted with unscaled upstream coordinates and the compatible downsample is forwarded unscaled; the committed golden records the mapped contract and is red until that mapping lands. `examples/headless-agent/tests/deferred-phone-tools.snapshot.ts` stays the model/fresh-probe compatibility scenario and is not extended.

## Alternatives considered

**Extend the deferred-phone session JSONL.** Rejected: that overlay never sends `kind: 'capture'` and never boots `phone-stream`.

**In-process `vi.mock` of dumpsys inside `routes.spec.ts` as the assembled gate.** Rejected: the gate must be a declared Loader snapshot, not a private unit mock.

**Broad snapshot normalizers for ports, tokens, and protocol messages.** Rejected: only mint identity fields are projected; JSON-RPC error text and mapped coordinates stay literal so a missing-bounds failure cannot match the aspect-mismatch golden.

**Wait for the backend freeze before writing the scenario.** Rejected for this test-only slice: the golden is an independent seam that stays red on current feature until mapping integrates.

## Consequences

The Host capture wire has a keyless assembled reject-and-map oracle. Contributors run one snapshot file; fakemobilecli and synthetic `adb` stay owned by that process and are disposed on every outcome. Real devices, Simulator, WDIO, and model keys stay out of this lane.
