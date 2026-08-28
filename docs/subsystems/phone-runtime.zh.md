# 手机运行时

[English](phone-runtime.md) | 中文

手机设备群缝：`packages/phone/phone-runtime` 在 mobilecli 仍是唯一后端期间，将 Service Definition 与其 mobilecli Service Provider 折叠于一个包；`packages/phone/tool-phone` 是延迟模型 Consumer。Service 持有外部 `mobilecli server start` 子进程（仅回环，使用去除凭据后的父环境启动），探测其 HTTP JSON-RPC 端点直至首个 `server.info` 成功应答，随后按配置节奏轮询 `devices.list`——结果接受裸设备数组或 mobilecli 1.0.5 的 `{ devices: [...] }` 信封两种形态，上游重复条目原样保留。设备 id 是 branded `DeviceId`（Android 序列号或 iOS UDID）；分组清单 `{ android, ios: { simulators, reals } }` 携带冻结的 `PhoneDeviceRef`，其 `kind` 翻译自上游 `type` 字段，其 `state` 原样保留上游状态——`unauthorized` 真机保留自身状态、在其接受信任提示前上游拒绝其 io，而非折叠进 offline——且 `online` 仅在上游 `online` 状态时为真。

失败语义是全量的：缺失或不可用的 mobilecli 二进制让组合响亮失败并附带安装指引；就绪前退出的子进程令插件初始化拒绝；就绪后的异常退出（或拒连、协议违背）将 Service 置为 lost，此后一切操作以记录的原因拒绝而非降级。所有操作将调用方 `AbortSignal` 与经校验的 Config 上限（`requestTimeoutMs`、`bootTimeoutMs`、`agentTimeoutMs`）融合；boot 与 shutdown 在任何 RPC 之前就在本包内拒绝真机。`io` 与 `startCapture` 接受真机，仅拒绝最新清单中不存在的 id。`startCapture` 将 `h264` 映射为上游 `avc`，并且只约束等待响应头的时间；未读的采集 body 由调用方持有。采集应答的两种上游形态均被跟随——裸流，以及 mobilecli 1.0.5 的 `{ format, sessionUrl }` 信封，会话 URL 相对服务器源归一并强制回到回环栅栏内。

iOS 真机链路位于清单的 real 分组之后：`agentStatus` 与 `installAgent` 以同一可执行文件的一次性 `agent status` / `agent install` 子进程驱动，幂等地保持设备端 agent 处于安装状态，并通过所配置的 `provisioningProfilePath` 为真机重签（上游要求真机 iOS 安装必须提供）。凡关于已安装、已重签真机的应答都携带 `FREE_SIGNING_PROFILE_REMINDER`——免费团队签名 7 天过期，`installAgent(id, { force: true })` 是复跑入口。输出中出现结构化错误臂的失败以 `PHONE_REAL_DEVICE_ISSUE` 暴露，错误臂由 `PhoneDevicesError.issue` 携带，agent 命令输出与上游 JSON-RPC 错误消息按同一规则分类；上游 `-32010` 仍保持 `PHONE_DEVICE_NOT_FOUND`。

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
