# @deepseek-ai/dsh-phone-runtime

[English](README.md) | 中文

基于外部 [mobilecli](https://github.com/mobile-next/mobilecli) 服务进程的手机设备群 Service：本包以子进程方式启动 `mobilecli server start --listen 127.0.0.1:<serverPort>`，轮询其 HTTP JSON-RPC 端点（方法名遵循上游 [OpenRPC 规范](https://github.com/mobile-next/mobile-openrpc/blob/main/mobilecli/openrpc.md)），并在 `ctx.phoneDevices` 上发布合并后的 Android/iOS 设备清单。mobilecli 仍是唯一后端，Service Definition 与 Provider 折叠于同一包；面向模型的延迟 Consumer 见 [`dsh-tool-phone`](../tool-phone/README.zh.md)，只 import 本包。

- `listDevices(signal?)` — 返回分组清单 `{ android, ios: { simulators, reals } }`；每项为冻结的 `PhoneDeviceRef`（`id` 为 branded `DeviceId`、`name`、`kind: 'emulator' | 'simulator' | 'real'`、`platform`、`state` 原样保留、`online`）。关机的模拟器/仿真器同样是合法 boot 目标，因此始终随查询发送 `includeOffline: true`。仅上游 `online` 状态映射为 `online: true`；其余一切上游状态——`offline`、`unauthorized` 等——在 `state` 上原样携带而不互相折叠，因此 `unauthorized` 真机在清单中始终可辨识（上游在其接受信任提示前拒绝其 io）。`devices.list` 结果的两种已发布形态——裸设备数组与 mobilecli 1.0.5 的 `{ devices: [...] }` 信封——均被接受，上游重复条目原样保留。
- `boot(id, signal?)` / `shutdown(id, signal?)` — 对应上游 `device.boot` / `device.shutdown`，以 branded id 寻址。真机在本包内先于 RPC 以 `PHONE_REAL_DEVICE` 拒绝（上游仅允许模拟器/仿真器），最新清单中不存在的 id 以 `PHONE_DEVICE_NOT_FOUND` 失败。变更成功后立即调度一次刷新轮询。
- `io(request, signal?)` — 对应上游 `device.io.tap` / `gesture` / `text` / `button`。真机是合法目标；仅最新清单中不存在的 id 在本包内以 `PHONE_DEVICE_NOT_FOUND` 失败。
- `startCapture(request)` — 对应上游 `device.screencapture`。`h264` 映射为上游 `avc`；返回的 `PhoneCaptureStream` 是尚未读取的 body，`contentType` 为上游响应头。`requestTimeoutMs` 只约束等待响应头的时间；body 取消由调用方持有。最新清单中不存在的 id 以 `PHONE_DEVICE_NOT_FOUND` 失败。
- `agentStatus(id, signal?)` / `installAgent(id, options?)` — iOS 真机链路，以对同一可执行文件的一次性 `agent status` / `agent install` 子进程驱动。安装幂等：不带 `force` 时先做 status 探测，已安装的 agent 直接应答而不触发任何安装子进程；`reinstalled` 标示一次强制重装。真机通过所配置的 `provisioningProfilePath` 重签（上游要求真机 iOS 安装必须提供）。凡关于已安装、已重签真机的应答都携带 `FREE_SIGNING_PROFILE_REMINDER`——免费团队签名 7 天过期的主动提示，并指明 `installAgent(id, { force: true })` 这一复跑入口。
- `onChanged(sub)` — 返回 disposer 的订阅；每条已提交的 `PhoneDeviceChange` 携带完整新清单以及相对上一条已发布清单的 `added`/`removed` id 数组。通知在提交轮询后同步投递，抛错的订阅者被拦截并记日志，订阅绝不比 Service 更长寿。

所有操作接受可选 `AbortSignal` 并执行经校验的时间上限；一切失败归一为 `PhoneDevicesError`（`PHONE_DISPOSED`、`PHONE_ABORTED`、`PHONE_TIMEOUT`、`PHONE_UNAVAILABLE`、`PHONE_UNRESOLVED`、`PHONE_PROTOCOL`、`PHONE_UPSTREAM`、`PHONE_DEVICE_NOT_FOUND`、`PHONE_REAL_DEVICE`、`PHONE_REAL_DEVICE_ISSUE`）。`PHONE_REAL_DEVICE_ISSUE` 在 `issue` 上携带结构化错误臂——`device-locked`、`cert-untrusted`、`profile-expired`、`tunnel-failed`、`device-unplugged`——由 agent 命令输出与上游 JSON-RPC 错误消息共同分类得出；上游 `-32010` 仍保持 `PHONE_DEVICE_NOT_FOUND`，Host 的 404 语义不受影响。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `executablePath` | — | 绝对路径或相对 cwd 的覆盖；缺省时逐个探测 `PATH` 目录寻找 `mobilecli`。 |
| `serverPort` | `12000` | 以 `--listen 127.0.0.1:<port>` 传入的回环端口；对齐上游默认。 |
| `pollIntervalMs` | `5000` | 健康探测与设备轮询节奏。 |
| `readyTimeoutMs` | `60000` | 首次就绪探测的总窗口；超时就绪失败将使插件响亮失败。 |
| `requestTimeoutMs` | `30000` | boot 之外每次 JSON-RPC 往返的上限；对齐上游 RPC 超时。 |
| `bootTimeoutMs` | `180000` | `device.boot` 的上限；对齐上游为慢启动授予的扩展写超时。 |
| `agentTimeoutMs` | `120000` | 单次 `agent status` / `agent install` 子进程的上限。 |
| `provisioningProfilePath` | — | 在真机上安装或重签 agent 时以 `--provisioning-profile` 传入的 `.mobileprovision`（上游要求真机 iOS 安装必须提供）；设置时该路径必须指向存在的文件。 |

## 扩展点

缺失或不可用的 mobilecli 会让组合响亮失败并附带安装指引（`npm install -g mobilecli@latest`；上游没有 Homebrew formula），绝不静默降级。本包同时导出 `./invariant` 伴生插件：它必须伴随每一个真实 Service 生成，并校验每条变更通知所标注的差异与其自身清单相对已发布清单的差异完全一致。

## 模型体验

通过 dsh-tool-phone 间接影响模型；该 Consumer 会渲染全部清单、观察、变更、动作与截图事实。

#### KV 缓存影响

与模型请求无关：Service 只启动本地 mobilecli 子进程、轮询设备状态并通知 Host 侧消费者；其发布内容不进入会话日志或模型上下文，因此前缀复用与缓存行为不受影响。

## 已知限制与后续工作

- **外部 FSL-1.1-Apache-2.0 依赖边界** — mobilecli 只被执行、绝不 vendor 或拷贝；其二进制不进入本仓库，行为随用户安装的版本而定，本包不锁定版本。
- **仅限回环** — 启动的服务始终绑定 `127.0.0.1:<serverPort>`；另一主机上 mobilecli 服务背后的远程设备群不在范围内。
- **需用户预装** — 未安装 mobilecli 时 Service 按设计拒绝组合；无自动下载、上游无 Homebrew formula，Android 还需 `adb` 在 PATH，iOS 模拟器需 Xcode Command Line Tools。
- **真机覆盖需显式开启** — 硬件在环套件仅在 `DSH_PHONE_REAL_UDID` 指明已连接真机（`DSH_PHONE_REAL_PROFILE` 指明其签名 profile）时运行；其余环境一律自跳过，因此 CI 只通过 fake mobilecli 垫片钉住真机链路。设备端 agent 工件由 mobilecli 在 `agent install` 时自行下载，本包绝不下载；iOS 设备隧道始终由 mobilecli 服务持有，隧道失败仅通过结构化的 `tunnel-failed` 臂暴露。
- **无 Windows 覆盖** — 本包套件中的 mobilecli 垫片场景仅限 POSIX；Windows 的 npm 全局 `.cmd` 垫片未经测试。请将 `executablePath` 指向原生 `mobilecli.exe`，在套件覆盖之前 Windows 视为未验证。
