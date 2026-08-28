# 手机运行时

[English](phone-runtime.md) | 中文

手机设备群缝：`packages/phone/phone-runtime` 在 mobilecli 仍是唯一后端期间，将 Service Definition 与其 mobilecli Service Provider 折叠于一个包；`packages/phone/tool-phone` 是延迟模型 Consumer。Service 持有外部 `mobilecli server start` 子进程（仅回环，使用去除凭据后的父环境启动），探测其 HTTP JSON-RPC 端点直至首个 `server.info` 成功应答，随后按配置节奏轮询 `devices.list`。设备 id 是 branded `DeviceId`（Android 序列号或 iOS UDID）；分组清单 `{ android, ios: { simulators, reals } }` 携带冻结的 `PhoneDeviceRef`，其 `kind` 翻译自上游 `type` 字段，`online` 仅在上游 `online` 状态时为真。

失败语义是全量的：缺失或不可用的 mobilecli 二进制让组合响亮失败并附带安装指引；就绪前退出的子进程令插件初始化拒绝；就绪后的异常退出（或拒连、协议违背）将 Service 置为 lost，此后一切操作以记录的原因拒绝而非降级。所有操作将调用方 `AbortSignal` 与经校验的 Config 上限（`requestTimeoutMs`、`bootTimeoutMs`）融合；boot 与 shutdown 在任何 RPC 之前就在本包内拒绝真机。`io` 与 `startCapture` 接受真机，仅拒绝最新清单中不存在的 id。`startCapture` 将 `h264` 映射为上游 `avc`，并且只约束等待响应头的时间；未读的采集 body 由调用方持有。

发布是单调且变更驱动的：只有当新分组清单与已发布清单存在差异（id 集、名称、kind 或 online 事实）时才发布，每条 `PhoneDeviceChange` 精确标注该差异的 added/removed id。`./invariant` 伴生插件基于已发布清单重推每条候选差异，不一致即响亮停轮询。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
