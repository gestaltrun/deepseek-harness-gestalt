# @deepseek-ai/dsh-phone-runtime

[English](README.md) | 中文

基于外部 [mobilecli](https://github.com/mobile-next/mobilecli) 服务进程的手机设备群 Service：本包在受管进程树中启动 `mobilecli server start --listen 127.0.0.1:<serverPort>`，轮询其 HTTP JSON-RPC 端点（方法名遵循上游 [OpenRPC 规范](https://github.com/mobile-next/mobile-openrpc/blob/main/mobilecli/openrpc.md)），并在 `ctx.phoneDevices` 上发布合并后的 Android/iOS 设备清单。进程树持有者覆盖 npm 的 Node 启动器及其派生的原生 mobilecli 进程，使 generation 替换与 teardown 在启动下一代之前释放回环端口。mobilecli 仍是唯一后端，Service Definition 与 Provider 折叠于同一包；面向模型的延迟 Consumer 见 [`dsh-tool-phone`](../tool-phone/README.zh.md)，只 import 本包。

- `listDevices(signal?)` — 返回分组清单 `{ android, ios: { simulators, reals } }`；每项为冻结的 `PhoneDeviceRef`（`id` 为 branded `DeviceId`、`name`、`kind: 'emulator' | 'simulator' | 'real'`、`platform`、`state` 原样保留、`online`）。关机的模拟器/仿真器同样是合法 boot 目标，因此始终随查询发送 `includeOffline: true`。仅上游 `online` 状态映射为 `online: true`；其余一切上游状态——`offline`、`unauthorized` 等——在 `state` 上原样携带而不互相折叠，因此 `unauthorized` 真机在清单中始终可辨识（上游在其接受信任提示前拒绝其 io）。`devices.list` 结果的两种已发布形态——裸设备数组与 mobilecli 1.0.5 的 `{ devices: [...] }` 信封——均被接受。wire 解析器会验证每一行，再为每个 `(platform, id)` 组合保留首行，避免上游重复项进入设置、picker 或 badge。由于 operation 只接受 `deviceId`，同一 id 出现在两个平台时会以歧义 `PHONE_PROTOCOL` 失败。
- `boot(id, signal?)` / `shutdown(id, signal?)` — 对应上游 `device.boot` / `device.shutdown`，以 branded id 寻址。真机在本包内先于 RPC 以 `PHONE_REAL_DEVICE` 拒绝（上游仅允许模拟器/仿真器），最新清单中不存在的 id 以 `PHONE_DEVICE_NOT_FOUND` 失败。变更成功后立即调度一次刷新轮询。
- `io(request, signal?)` — 对应上游 `device.io.tap` / `gesture` / `text` / `button`。此 API 的 tap 与 gesture 坐标使用采集画面像素；iOS 会读取并缓存官方 `device.info.screenSize.scale`，再把像素换算成 XCTest 逻辑点后转发；Android 保持逐像素传递。真机是合法目标；仅最新清单中不存在的 id 在本包内以 `PHONE_DEVICE_NOT_FOUND` 失败。
- `startCapture(request)` — 对应上游 `device.screencapture`。`h264` 映射为上游 `avc`；Android AVC 在到达 renderer 前先经过语法识别。mobilecli 若以 HTTP 200 返回错误正文、畸形码流，或在 `h264ProbeTimeoutMs` 内没有产出完整 key access unit，runtime 会从已选择的 SDK 或 PATH 调用 Android 系统 `screenrecord --output-format=h264`，继续保留 H264；设备发现与控制仍由 mobilecli 承担。两条 H264 源都失败时，renderer 可以进入 MJPEG 策略。mobilecli 的裸流和 1.0.5 `{ format, sessionUrl }` 信封都会被接受，信封会话 URL 必须留在回环栅栏内。`requestTimeoutMs` 约束响应头，`h264ProbeTimeoutMs` 约束每条 H264 源的识别；body 取消由调用方持有。未知 id 以 `PHONE_DEVICE_NOT_FOUND` 失败。
- `verifyAnnexBH264KeyAccessUnit(body, options)` — 对一个 Annex-B key access unit 内相互引用的 SPS、PPS 与 IDR slice 执行有界语法探测。它拒绝不完整、畸形、超限或已取消的输入，并在返回前等待 reader 取消完成；它不解码像素。
- `agentStatus(id, signal?)` / `installAgent(id, options?)` — 面向 iOS 模拟器与真机的设备端 agent 管理，以对同一可执行文件的一次性 `agent status` / `agent install` 进程树驱动。取消操作会等 Node 启动器与原生 mobilecli 后代进程全部退出后再返回。安装幂等：不带 `force` 时先做 status 探测，已安装的 agent 直接应答而不触发任何安装子进程；`reinstalled` 标示一次强制重装。真机通过所配置的 `provisioningProfilePath` 重签（上游要求真机 iOS 安装必须提供）。凡关于已安装、已重签真机的应答都携带 `FREE_SIGNING_PROFILE_REMINDER`——免费团队签名 7 天过期的主动提示，并指明 `installAgent(id, { force: true })` 这一复跑入口。
- `onChanged(sub)` — 返回 disposer 的订阅；每条已提交的 `PhoneDeviceChange` 携带完整新清单以及相对上一条已发布清单的 `added`/`removed` id 数组。通知在提交轮询后同步投递，抛错的订阅者被拦截并记日志，订阅绝不比 Service 更长寿。
- `isReady()` / `onReadinessChanged(sub)` — 当前 generation 的就绪状态与返回 disposer 的迁移订阅。`activateExecutable(path)` 会 abort 并排空上一代、停止其 child、发布其清单的 removals，再在同一 Service 身份后启动替代 generation。`deactivate()` 对称停止，并让后续操作保持 `PHONE_UNRESOLVED`，直到再次激活。

所有操作接受可选 `AbortSignal` 并执行经校验的时间上限；一切失败归一为 `PhoneDevicesError`（`PHONE_DISPOSED`、`PHONE_ABORTED`、`PHONE_TIMEOUT`、`PHONE_UNAVAILABLE`、`PHONE_UNRESOLVED`、`PHONE_PROTOCOL`、`PHONE_UPSTREAM`、`PHONE_DEVICE_NOT_FOUND`、`PHONE_AGENT_PROFILE_REQUIRED`、`PHONE_REAL_DEVICE`、`PHONE_REAL_DEVICE_ISSUE`）。iPhone 真机安装缺少必需的 `provisioningProfilePath` 时，runtime 会在调用 `mobilecli agent install` 前直接抛出 `PHONE_AGENT_PROFILE_REQUIRED`。`PHONE_REAL_DEVICE_ISSUE` 在 `issue` 上携带结构化错误臂——`device-locked`、`cert-untrusted`、`profile-expired`、`tunnel-failed`、`device-unplugged`——由 agent 命令输出与上游 JSON-RPC 错误消息共同分类得出；上游 `-32010` 仍保持 `PHONE_DEVICE_NOT_FOUND`，Host 的 404 语义不受影响。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `executablePath` | — | 绝对路径或相对 cwd 的覆盖；缺省时先搜 `PATH`，再搜 npm 全局、npx 缓存和 `npm_config_prefix`。Electron 极简 PATH 还会探测 `/opt/homebrew/bin` 与 `/usr/local/bin`。 |
| `deferStart` | `false` | 让稳定 Service 保持未解析，直到环境 owner 调用 `activateExecutable(path, signal?)`；运行时选择或托管准备发生在 Host 组合之后时使用。 |
| `serverPort` | `12000` | 以 `--listen 127.0.0.1:<port>` 传入的回环端口；对齐上游默认。 |
| `pollIntervalMs` | `5000` | 健康探测与设备轮询节奏。 |
| `readyStabilityMs` | `50` | 首份有效设备清单之后，发布就绪前要求子进程保持存活的时间。 |
| `readyTimeoutMs` | `60000` | 就绪探测、首份设备清单与稳定期的总窗口；超时就绪失败将使插件响亮失败。 |
| `requestTimeoutMs` | `30000` | boot 之外每次 JSON-RPC 往返的上限；对齐上游 RPC 超时。 |
| `h264ProbeTimeoutMs` | `15000` | 从每条候选源识别一个 Android H264 key access unit 的上限。 |
| `bootTimeoutMs` | `180000` | `device.boot` 的上限；对齐上游为慢启动授予的扩展写超时。 |
| `agentTimeoutMs` | `120000` | 单次 `agent status` / `agent install` 子进程的上限。 |
| `provisioningProfilePath` | — | 在真机上安装或重签 agent 时以 `--provisioning-profile` 传入的 `.mobileprovision`（上游要求真机 iOS 安装必须提供）；设置时该路径必须指向存在的文件。 |

## 扩展点

初始 mobilecli 缺失或不可用时 Service 仍会激活；`listDevices`、`boot`、`shutdown`、`io`、`startCapture` 与 agent 动词随后以 `PHONE_UNRESOLVED` 拒绝。Host 保持运行，`activateExecutable` 可在不替换 Service、不重启 Host 的情况下装入就绪 child。本包同时导出 `./invariant` 伴生插件：它必须伴随稳定 Service，并校验普通 poll 与 generation removal 通知所标注的差异与其自身清单相对已发布清单的差异完全一致。

## 模型体验

通过 dsh-tool-phone 间接影响模型；该 Consumer 会渲染全部清单、观察、变更、动作与截图事实。

#### KV 缓存影响

与模型请求无关：Service 只启动本地 mobilecli 子进程、轮询设备状态并通知 Host 侧消费者；其发布内容不进入会话日志或模型上下文，因此前缀复用与缓存行为不受影响。

## 已知限制与后续工作

- **外部 FSL-1.1-Apache-2.0 依赖边界** — mobilecli 只被执行，绝不 vendor 或拷入本仓库或 Desktop Bundle。任何固定上游下载及其发布阻塞项由 `phone-environment` 持有。
- **仅限回环** — 启动的服务始终绑定 `127.0.0.1:<serverPort>`；另一主机上 mobilecli 服务背后的远程设备群不在范围内。
- **平台工具链仍为外部依赖** — mobilecli 可在运行时激活；Android 仍需 `adb`，iOS 模拟器仍需 macOS 与 Xcode。其准备归属平台环境包。
- **真机覆盖需显式开启** — 硬件在环套件仅在 `DSH_PHONE_REAL_UDID` 指明已连接真机（`DSH_PHONE_REAL_PROFILE` 指明其签名 profile）时运行；其余环境一律自跳过，因此 CI 只通过 fake mobilecli 垫片钉住真机链路。设备端 agent 工件由 mobilecli 在 `agent install` 时自行下载，本包绝不下载；iOS 设备隧道始终由 mobilecli 服务持有，隧道失败仅通过结构化的 `tunnel-failed` 臂暴露。
- **Windows npm shim 缺口** — 原生 Windows 套件通过指向当前 Node 可执行文件的测试专用 `fakemobilecli.exe` 符号链接，覆盖生产解析器与进程生命周期。npm 全局 `.cmd` shim 仍未验证；在进程持有者支持批处理 shim 之前，`executablePath` 应指向原生 `mobilecli.exe`。
