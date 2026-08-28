# Phone Runtime

English | [中文](phone-runtime.zh.md)

The phone device fleet seam: `packages/phone/phone-runtime` folds the Service Definition and its mobilecli Service Provider into one package while mobilecli is the only backend, and `packages/phone/tool-phone` is the deferred model Consumer. The Service owns the external `mobilecli server start` child process (loopback-only, spawned with the credential-scrubbed parent environment), probes its HTTP JSON-RPC endpoint until the first successful `server.info` reply, then polls `devices.list` on the configured cadence — accepting the result as the bare device array or mobilecli 1.0.5's `{ devices: [...] }` envelope, with duplicate upstream entries kept verbatim. Device ids are branded `DeviceId` values (an Android serial or an iOS UDID); the grouped listing `{ android, ios: { simulators, reals } }` carries frozen `PhoneDeviceRef` entries whose `kind` translates the upstream `type` field, whose `state` carries the upstream state verbatim — an `unauthorized` handset keeps its state, with upstream refusing its io until the trust prompt is accepted, instead of folding into offline — and whose `online` is true only for the upstream `online` state.

Failure semantics are total: a missing or unusable mobilecli binary fails composition loudly with install guidance; a child that dies before readiness rejects plugin initialization; an unexpected post-ready exit (or a refused socket, or a protocol breach) marks the Service lost, and every later operation rejects with the recorded reason instead of degrading. All operations fuse the caller's `AbortSignal` with validated Config ceilings (`requestTimeoutMs`, `bootTimeoutMs`, `agentTimeoutMs`); boot and shutdown refuse physical handsets locally before any RPC. `io` and `startCapture` accept physical handsets and only refuse ids absent from the latest published listing. `startCapture` maps `h264` onto upstream `avc` and bounds only the wait for response headers; the caller owns the unread capture body.

The iOS real-device link lives behind the listing's real group: `agentStatus` and `installAgent` run the upstream `agent status` / `agent install` commands as one-shot children of the same executable, keeping the on-device agent installed idempotently and re-signing real handsets through the configured `provisioningProfilePath` (the upstream command requires it for real iOS installs). Every answer about an installed, re-signed real handset carries `FREE_SIGNING_PROFILE_REMINDER` — free-team profiles expire after 7 days, and `installAgent(id, { force: true })` is the re-run entry. Failures whose output names a structured arm surface as `PHONE_REAL_DEVICE_ISSUE` with the arm on `PhoneDevicesError.issue`, classified identically from agent-command output and upstream JSON-RPC error messages; upstream `-32010` stays `PHONE_DEVICE_NOT_FOUND`.

Publication is monotonic and change-driven: a poll publishes only when the freshly grouped listing differs from the published one (id set, name, kind, or online fact), and each `PhoneDeviceChange` names exactly the added/removed ids of that difference. The `./invariant` companion re-derives every candidate difference from the published listing and halts polling loudly on a mismatch.

```ts type-equiv
/** Upstream OpenRPC `device.io.*` verbs this Service forwards. */
type PhoneIoMethod = 'tap' | 'gesture' | 'text' | 'button'
```

```ts type-equiv
/** One JSON-RPC `device.io.*` request addressed by branded device id. */
type PhoneIoRequest =
  | { readonly deviceId: DeviceId; readonly method: 'tap'; readonly x: number; readonly y: number }
  | { readonly deviceId: DeviceId; readonly method: 'gesture'; readonly actions: readonly Record<string, unknown>[] }
  | { readonly deviceId: DeviceId; readonly method: 'text'; readonly text: string }
  | { readonly deviceId: DeviceId; readonly method: 'button'; readonly button: string }
```

```ts type-equiv
/** Screen-capture encoding the Host reverse-proxy may request. */
type PhoneCaptureFormat = 'mjpeg' | 'h264'
```

```ts type-equiv
/** Request that opens one upstream `device.screencapture` stream. */
interface PhoneCaptureRequest {
  /** Branded Android serial or iOS UDID whose screen to stream. */
  readonly deviceId: DeviceId
  /** `mjpeg` for both platforms; `h264` maps onto upstream `avc` (Android). */
  readonly format: PhoneCaptureFormat
  /** Optional caller cancellation fused with the request ceiling until headers arrive. */
  readonly signal?: AbortSignal
}
```

```ts type-equiv
/**
 * One live capture body owned by the caller. The Host must cancel `body` when
 * the browser disconnects so the upstream HTTP stream ends.
 */
interface PhoneCaptureStream {
  /** Upstream `Content-Type`, including the MJPEG boundary parameter when present. */
  readonly contentType: string
  /** Byte stream of the capture; cancel it to abort the upstream request. */
  readonly body: ReadableStream<Uint8Array>
}
```

```ts type-equiv
/**
 * Closed union of structured real-device failure arms. {@link classifyRealDeviceIssue}
 * names one arm from free-form mobilecli output; the matching
 * `PHONE_REAL_DEVICE_ISSUE` failure carries it on {@link PhoneDevicesError.issue}.
 */
type PhoneRealDeviceIssue =
  | 'device-locked'
  | 'cert-untrusted'
  | 'profile-expired'
  | 'tunnel-failed'
  | 'device-unplugged'
```

```ts type-equiv
/** Options for one on-device agent install. */
interface PhoneAgentInstallOptions {
  /** Reinstall and re-sign even when the agent already answers as installed. */
  readonly force?: boolean
  /** Optional caller cancellation bounding the whole install. */
  readonly signal?: AbortSignal
}
```

```ts type-equiv
/** One on-device agent status answer. */
interface PhoneAgentStatus {
  /** Device the answer is about. */
  readonly deviceId: DeviceId
  /** True only when the upstream agent command answered `status: ok`. */
  readonly installed: boolean
  /** Installed agent version; absent while `installed` is false. */
  readonly version?: string
  /** Installed agent bundle id; absent while `installed` is false. */
  readonly bundleId?: string
  /** Free-signing expiry reminder for a re-signed real handset; see the Service's `FREE_SIGNING_PROFILE_REMINDER`. */
  readonly profileReminder?: string
}
```

```ts type-equiv
/** One on-device agent install answer; `reinstalled` names a forced run this call performed. */
interface PhoneAgentInstallResult extends PhoneAgentStatus {
  /** True when this call ran a forced reinstall; false for a first install or an already-installed answer. */
  readonly reinstalled: boolean
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxphonedevices--phonedevices"></a>

### `ctx.phoneDevices` — `PhoneDevices`

Phone fleet Service over one external mobilecli server child. All operations accept an optional cancellation signal and enforce validated time ceilings; every failure normalizes onto PhoneDevicesError. A device-set notification is published only after a poll observes a real difference from the previously committed listing, and mobilecli problems fail loudly instead of degrading.

Operation failure codes:

- `PHONE_DISPOSED` — the owning fiber began teardown.
- `PHONE_ABORTED` — the caller's signal won before completion.
- `PHONE_TIMEOUT` — the operation's configured ceiling elapsed.
- `PHONE_UNAVAILABLE` — the child died or its socket refuses connections.
- `PHONE_PROTOCOL` — the upstream answer breaks its documented contract.
- `PHONE_UPSTREAM` — mobilecli returned a JSON-RPC error other than `-32010`.
- `PHONE_DEVICE_NOT_FOUND` — the id answers nothing upstream (`-32010`).
- `PHONE_REAL_DEVICE` — boot/shutdown targeted a physical handset.
- `PHONE_REAL_DEVICE_ISSUE` — the upstream output named a structured real-device failure arm; PhoneDevicesError.issue carries which one (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

`io` and `startCapture` accept physical handsets; they only refuse ids absent from the latest published listing. `agentStatus` and `installAgent` drive the upstream `agent status` / `agent install` commands as one-shot child runs of the same executable, keep the on-device agent installed idempotently, re-sign real handsets through the configured provisioning profile, and attach the free-signing expiry reminder to every answer about a re-signed real handset.

```ts cordis-catalog
/**
 * Fetch and publish one fresh grouped device listing.
 * @param signal - Caller's optional cancellation signal.
 * @returns the current grouped listing.
 * @throws {@link PhoneDevicesError} per the class-documented failure modes.
 */
async listDevices(signal?: AbortSignal): Promise<PhoneDeviceList>

/**
 * Boot one iOS simulator or Android emulator, then refresh the listing.
 * @param id - Branded id of the simulator/emulator to boot.
 * @param signal - Caller's optional cancellation signal.
 * @throws {@link PhoneDevicesError} with `PHONE_REAL_DEVICE` for physical handsets,
 *   `PHONE_DEVICE_NOT_FOUND` for ids absent from the latest published listing,
 *   and otherwise per the class-documented failure modes.
 */
async boot(id: DeviceId, signal?: AbortSignal): Promise<void>

/**
 * Shut down one iOS simulator or Android emulator, then refresh the listing.
 * Physical handsets are refused locally before any upstream call because the
 * upstream spec restricts both lifecycle verbs to simulators/emulators.
 * @param id - Branded id of the simulator/emulator to shut down.
 * @param signal - Caller's optional cancellation signal.
 * @throws {@link PhoneDevicesError} with `PHONE_REAL_DEVICE` for physical handsets,
 *   `PHONE_DEVICE_NOT_FOUND` for ids absent from the latest published listing,
 *   and otherwise per the class-documented failure modes.
 */
async shutdown(id: DeviceId, signal?: AbortSignal): Promise<void>

/**
 * Forward one `device.io.tap` / `gesture` / `text` / `button` round trip.
 * Physical handsets are valid targets; only ids absent from the latest
 * published listing fail locally before any RPC.
 * @param request - Branded device id plus the OpenRPC params for that verb.
 * @param signal - Caller's optional cancellation signal.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, and otherwise per the
 *   class-documented failure modes.
 */
async io(request: PhoneIoRequest, signal?: AbortSignal): Promise<void>

/**
 * Open one upstream `device.screencapture` stream. `h264` maps onto the
 * upstream `avc` format; the returned body is unread so the Host can proxy
 * frames without buffering a capture.
 * @param request - Branded device id, encoding, and optional cancellation.
 * @returns the live capture content type and body; the caller owns cancellation.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, and otherwise per the
 *   class-documented failure modes.
 */
async startCapture(request: PhoneCaptureRequest): Promise<PhoneCaptureStream>

/**
 * Report the on-device agent installation state for one listed device by
 * running the upstream `agent status` command as a one-shot child of the
 * same executable the loopback server was spawned from. Answers about a
 * re-signed real handset carry the free-signing expiry reminder.
 * @param id - Branded id of the device to inspect.
 * @param signal - Caller's optional cancellation signal.
 * @returns the parsed installation state.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, `PHONE_REAL_DEVICE_ISSUE` when
 *   the command output names a structured real-device arm, and otherwise per
 *   the class-documented failure modes.
 */
async agentStatus(id: DeviceId, signal?: AbortSignal): Promise<PhoneAgentStatus>

/**
 * Keep the on-device agent installed for one listed device. Without `force`
 * the upstream `agent status` command runs first and an already-installed
 * agent answers without any install spawn, so repeated calls are idempotent;
 * `force` reinstalls and re-signs through the configured provisioning
 * profile, which real iOS installs require upstream.
 * @param id - Branded id of the device to install on.
 * @param options - Force reinstall switch and optional cancellation.
 * @returns the resulting installation state; `reinstalled` is true only when
 *   this call spawned an install.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, `PHONE_REAL_DEVICE_ISSUE` when
 *   the command output names a structured real-device arm, and otherwise per
 *   the class-documented failure modes.
 */
async installAgent(id: DeviceId, options: PhoneAgentInstallOptions = {}): Promise<PhoneAgentInstallResult>

/**
 * Subscribe to committed device-set changes. Delivery happens synchronously
 * after each committing poll; a throwing subscriber is contained and logged.
 * @param sub - Observer receiving every committed {@link PhoneDeviceChange}.
 * @returns disposer removing exactly this subscription; subscriptions never outlive the Service.
 */
onChanged(sub: (change: PhoneDeviceChange) => void): () => void
```

Source: [`packages/phone/phone-runtime/src/index.ts`](../../packages/phone/phone-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
