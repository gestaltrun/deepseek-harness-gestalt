# 手机运行时

[English](phone-runtime.md) | 中文

手机设备群缝：`packages/phone/phone-runtime` 在 mobilecli 仍是唯一后端期间，将服务定义与其 mobilecli 服务提供方折叠于一个包；`packages/phone/tool-phone` 是延迟模型消费方。服务持有外部 `mobilecli server start` 子进程（仅回环，使用去除凭据后的父环境启动），探测其 HTTP JSON-RPC 端点直至首个 `server.info` 成功应答，随后按配置节奏轮询 `devices.list`——结果接受裸设备数组或 mobilecli 1.0.5 的 `{ devices: [...] }` 信封两种形态，上游重复条目原样保留。设备 id 是 branded `DeviceId`（Android 序列号或 iOS UDID）；分组清单 `{ android, ios: { simulators, reals } }` 携带冻结的 `PhoneDeviceRef`，其 `kind` 翻译自上游 `type` 字段，其 `state` 原样保留上游状态——`unauthorized` 真机保留自身状态、在其接受信任提示前上游拒绝其 io，而非折叠进 offline——且 `online` 仅在上游 `online` 状态时为真。

失败语义是全量的：缺失或不可用的 mobilecli 二进制仍会激活服务，此后一切操作以 `PHONE_UNRESOLVED` 拒绝并附带安装指引；就绪前退出的子进程令插件初始化拒绝；就绪后的异常退出（或拒连、协议违背）将服务置为 lost，此后一切操作以记录的原因拒绝而非降级。所有操作将调用方 `AbortSignal` 与经校验的 Config 上限（`requestTimeoutMs`、`bootTimeoutMs`、`agentTimeoutMs`）融合；boot 与 shutdown 在任何 RPC 之前就在本包内拒绝真机。`io`、`startCapture` 与 `screenshot` 接受真机，仅拒绝最新清单中不存在的 id。`startCapture` 将 `h264` 映射为上游 `avc`，并约束等待响应头的时间；已发布且未读的采集 body 由调用方持有。响应头到达后若 generation 或 incarnation 已过期，runtime 会在 `captureCleanupTimeoutMs` 内等待外部 body 取消。采集应答的两种上游形态均被跟随——裸流，以及 mobilecli 1.0.5 的 `{ format, sessionUrl }` 信封，会话 URL 相对服务器源归一并强制回到回环栅栏内。`screenshot` 通过 `mobilecli screenshot --format png` 返回一张 PNG 静帧，并持久化到 `$DSH_HOME/phone/screenshots` 下仅所有者可读写的路径。

iOS 真机链路位于清单的 real 分组之后：`agentStatus` 与 `installAgent` 以同一可执行文件的一次性 `agent status` / `agent install` 子进程驱动，幂等地保持设备端 agent 处于安装状态，并通过所配置的 `provisioningProfilePath` 为真机重签（上游要求真机 iOS 安装必须提供）。凡关于已安装、已重签真机的应答都携带 `FREE_SIGNING_PROFILE_REMINDER`——免费团队签名 7 天过期，`installAgent(id, { force: true })` 是复跑入口。输出中出现结构化错误臂的失败以 `PHONE_REAL_DEVICE_ISSUE` 暴露，错误臂由 `PhoneDevicesError.issue` 携带，agent 命令输出与上游 JSON-RPC 错误消息按同一规则分类；上游 `-32010` 仍保持 `PHONE_DEVICE_NOT_FOUND`。

发布是单调且变更驱动的：只有当新分组清单与已发布清单存在差异（id 集、名称、kind 或 online 事实）时才发布，每条 `PhoneDeviceChange` 精确标注该差异的 added/removed id。`./invariant` 伴生插件基于已发布清单重推每条候选差异，不一致即响亮停轮询。

`ctx.phoneEnvironment` 发布供「手机设备」设置使用的 revisioned `PhoneEnvironmentSnapshot`：其中包含持久化启用值、共享运行时状态，以及相互独立的 Android/iOS 准备状态。运行时按运维 override、托管 current、系统发现的顺序选择。平台提供方注册在同一服务后方；Android 提供方准备固定 API 35 SDK/AVD，并贡献仅子进程使用的 SDK 环境项。运行中的平台只有在选中的 mobilecli 代携带这些环境项重新激活、将 branded emulator id 列为在线并产出语法有效的 Annex-B key access unit，且其中的 SPS、PPS 与 IDR slice header 相互引用一致后，才成为 ready。Host 探测不解码像素；真实画面的 GUI 验收保持独立。关闭、取消或 teardown 会取消整段事务并停止所持有的 Emulator 与 mobilecli 子进程。

```ts type-equiv
/** Closed semantic actions accepted by the phone fleet Service. */
type PhoneIoMethod = 'tap' | 'swipe' | 'text' | 'button'
```

```ts type-equiv
/** Exact clockwise rotation required to display a captured frame. */
type PhoneRotation = 0 | 90 | 180 | 270
```

```ts type-equiv
/** Trusted coordinate-plane source for one semantic coordinate action. */
type PhoneCoordinateSource =
  | { readonly kind: 'fresh-probe' }
  | {
    readonly kind: 'capture'
    readonly captureId: PhoneCaptureId
    readonly captureFormat: PhoneCaptureFormat
    readonly captureWidth: number
    readonly captureHeight: number
    readonly captureRotation?: PhoneRotation
  }
```

```ts type-equiv
/** One semantic phone action addressed by branded device id. */
type PhoneIoRequest =
  | { readonly deviceId: DeviceId; readonly method: 'tap'; readonly x: number; readonly y: number; readonly source: PhoneCoordinateSource }
  | {
    readonly deviceId: DeviceId
    readonly method: 'swipe'
    readonly x1: number
    readonly y1: number
    readonly x2: number
    readonly y2: number
    readonly source: PhoneCoordinateSource
  }
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
  /** Runtime-owned identity binding active observation and later coordinate projection when the caller needs coordinate evidence. */
  readonly captureId?: PhoneCaptureId
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
/** One still PNG captured from a listed device. */
interface PhoneScreenshot {
  /** Always PNG; the still comes from `mobilecli screenshot --format png`. */
  readonly mediaType: 'image/png'
  /** Absolute owner-only PNG path under `$DSH_HOME/phone/screenshots`. */
  readonly path: string
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

Phone fleet Service over one external mobilecli server child. All operations accept an optional cancellation signal and enforce validated time ceilings; every failure normalizes onto PhoneDevicesError. A device-set notification is published only after a poll observes a real difference from the previously committed listing. An unresolvable mobilecli still activates the Service; every operation then rejects with `PHONE_UNRESOLVED` and install guidance instead of failing composition.

Operation failure codes:

- `PHONE_DISPOSED` — the owning fiber began teardown.
- `PHONE_ABORTED` — the caller's signal won before completion.
- `PHONE_TIMEOUT` — the operation's configured ceiling elapsed.
- `PHONE_UNAVAILABLE` — the child died or its socket refuses connections.
- `PHONE_UNRESOLVED` — the mobilecli executable could not be resolved.
- `PHONE_PROTOCOL` — the upstream answer breaks its documented contract.
- `PHONE_UPSTREAM` — mobilecli returned a JSON-RPC error other than `-32010`.
- `PHONE_DEVICE_NOT_FOUND` — the id answers nothing upstream (`-32010`).
- `PHONE_REAL_DEVICE` — boot/shutdown targeted a physical handset.
- `PHONE_REAL_DEVICE_ISSUE` — the upstream output named a structured real-device failure arm; PhoneDevicesError.issue carries which one (`device-locked`, `cert-untrusted`, `profile-expired`, `tunnel-failed`, `device-unplugged`).

`io`, `startCapture`, and `screenshot` accept physical handsets; they only refuse ids absent from the latest published listing. `agentStatus` and `installAgent` drive the upstream `agent status` / `agent install` commands as one-shot child runs of the same executable, keep the on-device agent installed idempotently, re-sign real handsets through the configured provisioning profile, and attach the free-signing expiry reminder to every answer about a re-signed real handset.

```ts cordis-catalog
/**
 * Read whether the current child may accept fleet operations.
 * @returns current generation readiness.
 */
isReady(): boolean

/**
 * Subscribe to ready/not-ready transitions of the replaceable runtime generation.
 * @param listener - callback receiving the committed readiness value.
 * @returns the disposer.
 */
onReadinessChanged(listener: (ready: boolean) => void): () => void

/**
 * Replace the owned mobilecli child generation without replacing this Service.
 * In-flight work on the prior generation is aborted and its process is stopped
 * before the replacement begins readiness probing.
 * @param executablePath - absolute executable path selected by the environment owner.
 * @param signal - optional cancellation signal for replacement and readiness.
 * @param environment - non-sensitive SDK/AVD environment owned by the selected generation.
 */
async activateExecutable( executablePath: string, signal?: AbortSignal, environment: Readonly<Record<string, string>> = {}, ): Promise<void>

/** Stop the current child generation while retaining this Service for later activation. */
async deactivate(): Promise<void>

/**
 * Fetch and publish one fresh grouped device listing. Online Android rows
 * may carry `logicalDisplay` from `dumpsys display` `logicalFrame`.
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
 * Execute one semantic tap, swipe, text, or button action. Capture-source
 * `x`/`y` and `captureWidth`/`captureHeight` remain the decoded plane.
 * Android capture-source taps and swipes scale both axes onto the current
 * incarnation `logicalDisplay`; missing logical bounds or a capture plane
 * that fails the uniform full-frame aspect assumption fail with
 * `PHONE_PROTOCOL` before RPC. A dumpsys miss does not replace the
 * incarnation. Android fresh-probe pixels
 * pass through. iOS obtains cached portrait `device.info` bounds and
 * projects every displayed endpoint through exact rotation; browser actions
 * bind current capture identity and model actions use a bounded fresh MJPEG
 * EXIF probe. Button and text stay independent of coordinate conversion.
 * Physical handsets are valid targets; only ids absent from the latest
 * published listing fail locally before any RPC.
 * @param request - Branded device id plus capture-pixel or non-coordinate input.
 * @param signal - Caller's optional cancellation signal.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, `PHONE_PROTOCOL` when an iOS
 *   `device.info` answer lacks a valid positive screen size or Android
 *   capture-source input lacks a current logical display that matches the
 *   uniform full-frame aspect assumption, and
 *   otherwise per the class-documented failure modes.
 */
async io(request: PhoneIoRequest, signal?: AbortSignal): Promise<void>

/**
 * Open one `device.screencapture` stream. `h264` maps onto upstream `avc`;
 * Android pre-reads and replays at most one bounded key-access-unit probe,
 * then replaces an invalid, failed, timed-out, or landscape-logical-display
 * source with the system `screenrecord` H264 stream (`--size` from
 * `dumpsys display` `logicalFrame` when known). Other bodies remain unread.
 * A generation or incarnation change after headers joins foreign body
 * cancellation for at most `captureCleanupTimeoutMs`.
 * @param request - Branded device id, encoding, and optional cancellation.
 * @returns the live capture content type and body; the caller owns cancellation.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, and otherwise per the
 *   class-documented failure modes.
 */
async startCapture(request: PhoneCaptureRequest): Promise<PhoneCaptureStream>

/**
 * Capture one PNG still of a listed device through `mobilecli screenshot`.
 * Live MJPEG/H264 capture stays on `startCapture`.
 * @param id - Branded Android serial or iOS UDID whose screen to capture.
 * @param signal - Caller's optional cancellation signal.
 * @returns PNG media type and the absolute owner-only file path.
 * @throws {@link PhoneDevicesError} with `PHONE_DEVICE_NOT_FOUND` for ids
 *   absent from the latest published listing, and otherwise per the
 *   class-documented failure modes.
 */
async screenshot(id: DeviceId, signal?: AbortSignal): Promise<PhoneScreenshot>

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
 *   absent from the latest published listing, `PHONE_AGENT_PROFILE_REQUIRED`
 *   when a real-iOS install lacks `provisioningProfilePath`,
 *   `PHONE_REAL_DEVICE_ISSUE` when the command output names a structured
 *   real-device arm, and otherwise per the class-documented failure modes.
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

<a id="ctxphoneenvironment--phoneenvironment"></a>

### `ctx.phoneEnvironment` — `PhoneEnvironment`

Stable Host Service for phone runtime discovery, preparation, and activation.

```ts cordis-catalog
/**
 * Read the latest committed environment state.
 * @returns the current immutable full snapshot.
 */
snapshot(): PhoneEnvironmentSnapshot

/**
 * Apply the durable settings gate and symmetrically activate or stop the child generation.
 * @param enabled - current `ui-phone.enabled` value.
 */
setEnabled(enabled: boolean): Promise<void>

/**
 * Subscribe to committed full-snapshot replacements.
 * @param listener - callback receiving the new immutable snapshot.
 * @returns the disposer.
 */
onChanged(listener: (snapshot: PhoneEnvironmentSnapshot) => void): () => void

/**
 * Register the Android platform Provider while retaining this Service as the full-snapshot owner.
 * @param provider - Android SDK, AVD, and emulator lifecycle owner.
 * @returns disposer that detaches the Provider and restores the deferred state.
 */
registerAndroidEnvironment(provider: AndroidEnvironmentProvider): () => void

/**
 * Register the iOS platform Provider while retaining this Service as the full-snapshot owner.
 * A running snapshot discovered during registration remains pending until
 * the active mobilecli generation passes list and picture verification.
 * @param provider - Xcode runtime and Simulator lifecycle owner.
 * @returns disposer that detaches the Provider and restores the deferred state.
 */
registerIosEnvironment(provider: IosEnvironmentProvider): () => void

/**
 * Re-detect runtime sources in fixed override-managed-system precedence.
 * @param signal - optional owner cancellation for detection and activation.
 * @returns the committed full snapshot after detection settles.
 */
refresh(signal?: AbortSignal): Promise<PhoneEnvironmentSnapshot>

/**
 * Download, verify, publish, and optionally activate the pinned host asset.
 * @returns the committed full snapshot after preparation settles.
 * @throws {@link PhoneEnvironmentError} with `PHONE_ENVIRONMENT_OVERRIDE` while
 *   `executablePath` is authoritative, `PHONE_ENVIRONMENT_BUSY` for concurrent
 *   preparation, or the documented download, verification, filesystem,
 *   cancellation, and activation codes.
 */
prepare(): Promise<PhoneEnvironmentSnapshot>

/** Cancel the current detection, download, version probe, or child activation. */
cancel(): void
```

Source: [`packages/phone/phone-environment/src/index.ts`](../../packages/phone/phone-environment/src/index.ts)
<!-- END GENERATED cordis-surface -->
