# @deepseek-ai/dsh-phone-runtime

[English](README.md) | 中文

基于外部 [mobilecli](https://github.com/mobile-next/mobilecli) 服务进程的手机设备群 Service：本包以子进程方式启动 `mobilecli server start --listen 127.0.0.1:<serverPort>`，轮询其 HTTP JSON-RPC 端点（方法名遵循上游 [OpenRPC 规范](https://github.com/mobile-next/mobile-openrpc/blob/main/mobilecli/openrpc.md)），并在 `ctx.phoneDevices` 上发布合并后的 Android/iOS 设备清单。mobilecli 仍是唯一后端，Service Definition 与 Provider 折叠于同一包；面向模型的延迟 Consumer 见 [`dsh-tool-phone`](../tool-phone/README.zh.md)，只 import 本包。

- `listDevices(signal?)` — 返回分组清单 `{ android, ios: { simulators, reals } }`；每项为冻结的 `PhoneDeviceRef`（`id` 为 branded `DeviceId`、`name`、`kind: 'emulator' | 'simulator' | 'real'`、`online`）。关机的模拟器/仿真器同样是合法 boot 目标，因此始终随查询发送 `includeOffline: true`；仅上游 `online` 状态映射为 `online: true`（`offline`、`unauthorized` 等一律 false）。
- `boot(id, signal?)` / `shutdown(id, signal?)` — 对应上游 `device.boot` / `device.shutdown`，以 branded id 寻址。真机在本包内先于 RPC 以 `PHONE_REAL_DEVICE` 拒绝（上游仅允许模拟器/仿真器），最新清单中不存在的 id 以 `PHONE_DEVICE_NOT_FOUND` 失败。变更成功后立即调度一次刷新轮询。
- `onChanged(sub)` — 返回 disposer 的订阅；每条已提交的 `PhoneDeviceChange` 携带完整新清单以及相对上一条已发布清单的 `added`/`removed` id 数组。通知在提交轮询后同步投递，抛错的订阅者被拦截并记日志，订阅绝不比 Service 更长寿。

所有操作接受可选 `AbortSignal` 并执行经校验的时间上限；一切失败归一为 `PhoneDevicesError`（`PHONE_DISPOSED`、`PHONE_ABORTED`、`PHONE_TIMEOUT`、`PHONE_UNAVAILABLE`、`PHONE_UNRESOLVED`、`PHONE_PROTOCOL`、`PHONE_UPSTREAM`、`PHONE_DEVICE_NOT_FOUND`、`PHONE_REAL_DEVICE`）。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `executablePath` | — | 绝对路径或相对 cwd 的覆盖；缺省时逐个探测 `PATH` 目录寻找 `mobilecli`。 |
| `serverPort` | `12000` | 以 `--listen 127.0.0.1:<port>` 传入的回环端口；对齐上游默认。 |
| `pollIntervalMs` | `5000` | 健康探测与设备轮询节奏。 |
| `readyTimeoutMs` | `60000` | 首次就绪探测的总窗口；超时就绪失败将使插件响亮失败。 |
| `requestTimeoutMs` | `30000` | boot 之外每次 JSON-RPC 往返的上限；对齐上游 RPC 超时。 |
| `bootTimeoutMs` | `180000` | `device.boot` 的上限；对齐上游为慢启动授予的扩展写超时。 |

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
- **无 Windows 覆盖** — 本包套件中的 mobilecli 垫片场景仅限 POSIX；Windows 的 npm 全局 `.cmd` 垫片未经测试。请将 `executablePath` 指向原生 `mobilecli.exe`，在套件覆盖之前 Windows 视为未验证。
