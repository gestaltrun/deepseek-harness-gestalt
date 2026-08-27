# Phone Runtime

English | [中文](phone-runtime.zh.md)

The phone device fleet seam: `packages/phone/phone-runtime` folds the Service Definition and its mobilecli Service Provider into one package while mobilecli is the only backend. The Service owns the external `mobilecli server start` child process (loopback-only, spawned with the credential-scrubbed parent environment), probes its HTTP JSON-RPC endpoint until the first successful `server.info` reply, then polls `devices.list` on the configured cadence. Device ids are branded `DeviceId` values (an Android serial or an iOS UDID); the grouped listing `{ android, ios: { simulators, reals } }` carries frozen `PhoneDeviceRef` entries whose `kind` translates the upstream `type` field and whose `online` is true only for the upstream `online` state.

Failure semantics are total: a missing or unusable mobilecli binary fails composition loudly with install guidance; a child that dies before readiness rejects plugin initialization; an unexpected post-ready exit (or a refused socket, or a protocol breach) marks the Service lost, and every later operation rejects with the recorded reason instead of degrading. All operations fuse the caller's `AbortSignal` with validated Config ceilings (`requestTimeoutMs`, `bootTimeoutMs`); boot and shutdown refuse physical handsets locally before any RPC.

Publication is monotonic and change-driven: a poll publishes only when the freshly grouped listing differs from the published one (id set, name, kind, or online fact), and each `PhoneDeviceChange` names exactly the added/removed ids of that difference. The `./invariant` companion re-derives every candidate difference from the published listing and halts polling loudly on a mismatch.

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
 * Subscribe to committed device-set changes. Delivery happens synchronously
 * after each committing poll; a throwing subscriber is contained and logged.
 * @param sub - Observer receiving every committed {@link PhoneDeviceChange}.
 * @returns disposer removing exactly this subscription; subscriptions never outlive the Service.
 */
onChanged(sub: (change: PhoneDeviceChange) => void): () => void
```

Source: [`packages/phone/phone-runtime/src/index.ts`](../../packages/phone/phone-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
