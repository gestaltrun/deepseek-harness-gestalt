# Phone Runtime

English | [中文](phone-runtime.zh.md)

The phone device fleet seam: `packages/phone/phone-runtime` folds the Service Definition and its mobilecli Service Provider into one package while mobilecli is the only backend, and `packages/phone/tool-phone` is the deferred model Consumer. The Service owns the external `mobilecli server start` child process (loopback-only, spawned with the credential-scrubbed parent environment), probes its HTTP JSON-RPC endpoint until the first successful `server.info` reply, then polls `devices.list` on the configured cadence. Device ids are branded `DeviceId` values (an Android serial or an iOS UDID); the grouped listing `{ android, ios: { simulators, reals } }` carries frozen `PhoneDeviceRef` entries whose `kind` translates the upstream `type` field and whose `online` is true only for the upstream `online` state.

Failure semantics are total: a missing or unusable mobilecli binary fails composition loudly with install guidance; a child that dies before readiness rejects plugin initialization; an unexpected post-ready exit (or a refused socket, or a protocol breach) marks the Service lost, and every later operation rejects with the recorded reason instead of degrading. All operations fuse the caller's `AbortSignal` with validated Config ceilings (`requestTimeoutMs`, `bootTimeoutMs`); boot and shutdown refuse physical handsets locally before any RPC. `io` and `startCapture` accept physical handsets and only refuse ids absent from the latest published listing. `startCapture` maps `h264` onto upstream `avc` and bounds only the wait for response headers; the caller owns the unread capture body.

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

`io` and `startCapture` accept physical handsets; they only refuse ids absent from the latest published listing.

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
 * Subscribe to committed device-set changes. Delivery happens synchronously
 * after each committing poll; a throwing subscriber is contained and logged.
 * @param sub - Observer receiving every committed {@link PhoneDeviceChange}.
 * @returns disposer removing exactly this subscription; subscriptions never outlive the Service.
 */
onChanged(sub: (change: PhoneDeviceChange) => void): () => void
```

Source: [`packages/phone/phone-runtime/src/index.ts`](../../packages/phone/phone-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
