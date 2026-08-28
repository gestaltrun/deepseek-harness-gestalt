# Phone Stream

English | [中文](phone-stream.zh.md)

Same-origin phone IO and capture reverse-proxy: `packages/phone/phone-stream` injects `phoneDevices` and `webServer`, registers Host routes, and publishes `ctx.phoneStream`. The browser never dials mobilecli `:12000`. IO rides `/phone/ws/io` after the `/api` trust fence. MJPEG and H264 frames ride signed Host-origin URLs that additionally require a loopback Host and a short-lived HMAC token. Picture aspect (fixed 1:2, axis 3) is a GUI consumer contract; this package only mints stream URLs and forwards frames.

```ts type-equiv
/** One signed same-origin capture URL plus its expiry. */
interface PhoneStreamUrl {
  /** Path and query the browser loads on this Host; never a `:12000` origin. */
  readonly url: string
  /** Unix epoch milliseconds after which the Host refuses this URL. */
  readonly expiresAt: number
}
```

```ts type-equiv
/** Same-origin IO socket path and signed MJPEG/H264 URLs for one device. */
interface PhoneStreamSession {
  /** Branded device these URLs address. */
  readonly deviceId: DeviceId
  /** Exact-path WebSocket upgrade that forwards `device.io.*` JSON-RPC. */
  readonly ioPath: string
  /** Signed MJPEG capture URL. */
  readonly mjpeg: PhoneStreamUrl
  /** Signed H264 (`avc`) capture URL. */
  readonly h264: PhoneStreamUrl
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxphonestream--phonestream"></a>

### `ctx.phoneStream` — `PhoneStream`

Same-origin phone stream Consumer. It injects `phoneDevices` and `webServer`, registers the IO upgrade and signed capture routes, and publishes `ctx.phoneStream` so later GUI consumers can mint URLs without talking to `:12000`.

```ts cordis-catalog
/**
 * Mint signed same-origin MJPEG and H264 URLs for one known device.
 * @param id - Branded device id present in the latest published listing.
 * @returns the IO upgrade path plus both capture URLs and their expiry.
 */
sessionFor(id: DeviceId): PhoneStreamSession
```

Types: [DeviceId](phone-runtime.md)

Source: [`packages/phone/phone-stream/src/index.ts`](../../packages/phone/phone-stream/src/index.ts)
<!-- END GENERATED cordis-surface -->
