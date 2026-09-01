# 手机流

[English](phone-stream.md) | 中文

同源手机 IO 与采集反代：`packages/phone/phone-stream` 注入 `phoneDevices` 与 `webServer`，注册 Host 路由，并发布 `ctx.phoneStream`。浏览器永不直连 mobilecli `:12000`。IO 在 `/api` 信任栅栏之后走 `/phone/ws/io`。MJPEG 与 H264 帧走签名的 Host 同源 URL，并且额外要求 loopback Host 与短时效 HMAC token。画面比例（固定 1:2，轴 3）是 GUI Consumer 的约定；本包只签发流 URL 并转发帧。

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
  /** Whether this session addresses an iOS real device whose on-device agent is product-managed. */
  readonly agentManaged: boolean
  /** Signed MJPEG capture URL. */
  readonly mjpeg: PhoneStreamUrl
  /** Signed H264 (`avc`) capture URL. */
  readonly h264: PhoneStreamUrl
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxphonestream--phonestream"></a>

### `ctx.phoneStream` — `PhoneStream`

Same-origin phone stream Consumer. It injects `phoneDevices` and `webServer`, registers the IO upgrade and signed capture routes, and publishes `ctx.phoneStream` so later GUI consumers can mint URLs without talking to `:12000`.

```ts cordis-catalog
/**
 * Mint signed same-origin MJPEG and H264 URLs for one known device.
 * @param id - Branded device id present in the latest published listing.
 * @param agentManaged - Whether the session addresses an iOS real device whose agent is managed through this Consumer.
 * @returns the IO upgrade path plus both capture URLs and their expiry.
 */
sessionFor(id: DeviceId, agentManaged: boolean = false): PhoneStreamSession
```

Types: [DeviceId](phone-runtime.zh.md)

Source: [`packages/phone/phone-stream/src/index.ts`](../../packages/phone/phone-stream/src/index.ts)
<!-- END GENERATED cordis-surface -->
