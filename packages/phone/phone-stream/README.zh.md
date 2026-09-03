# @deepseek-ai/dsh-phone-stream

[English](README.md) | 中文

手机 IO、屏幕采集与 Android/iOS 真机托管 agent 恢复的同源 Host Consumer。插件注入 `phoneDevices` 与 `webServer`，注册设备清单和 agent 路由、一条 WebSocket 升级路由和签名 HTTP 采集路由，并发布 `ctx.phoneStream`。浏览器永不直连 mobilecli `:12000`：tap/gesture/text/button JSON-RPC 走 `/phone/ws/io`，MJPEG/H264 帧走由 `sessionFor` 签发的 Host 同源 URL。画面排版（固定 1:2，轴 3）是 GUI Consumer 的约定；本包只签发流 URL 并转发帧。

- `sessionFor(id, agentManaged, preferredFormat)` — IO 升级路径、设备类别的首选编码，以及签名的 `mjpeg` 与 `h264` URL，查询 token 在 `tokenTtlMs` 后过期；`agentManaged` 标记控制失败可进入 agent 恢复的 Android 与 iOS 真机会话。
- `POST /phone/session` — 为最新清单中存在的设备签发这些 URL；先执行 `/api` 信任栅栏。Android 设备与 iOS 真机首选 H264；iOS 模拟器因 mobilecli 会拒绝其 AVC 采集请求而首选 MJPEG。iOS 真机会先运行 `agentStatus`，缺失时返回 `PHONE_AGENT_MISSING`。Android 与成功的 iOS 真机 session 都携带 `agentManaged: true`，使后续控制或画面失败能够复检 agent。
- `POST /phone/agent/status` 与 `POST /phone/agent/install` — 为清单中的 Android 与 iOS 真机检测、安装或强制重装设备控制代理，并拒绝 iOS 模拟器。Android 安装在产品内保持一键完成；OEM 系统确认或开发者安全开关仍必须在手机上同意。签名 identity、provisioning profile 选择、Developer Mode、设备解锁与信任仍由用户处理。未配置 `provisioningProfilePath` 时返回带配置动作的 `PHONE_AGENT_PROFILE_REQUIRED`，不退化成通用上游失败。
- `GET /phone/devices` — 依据最近一次 `phoneDevices.listDevices()` 应答分组后的设备清单（`android`、`ios.simulators`、`ios.reals`；每项含 `id`/`name`/`kind`/`state`/`online`，`state` 原样保留上游状态）；先执行 `/api` 信任栅栏，仅限精确路径的 GET。`PHONE_DEVICE_NOT_FOUND` 以外的 `PhoneDevicesError` 以 502 返回 `{ error: { code, message, issue? } }`，保留每个 `PHONE_REAL_DEVICE_ISSUE` 分支，并把 `PHONE_UNRESOLVED` 安装指引带到浏览器。
- `GET /phone/stream/<id>/<mjpeg|h264>?token=` — 反代 `device.screencapture`。先执行 `/api` 信任栅栏，再执行 loopback Host 栅栏，最后校验 HMAC；过期、伪造或非 loopback 请求返回 403。代理接受上游 `device.screencapture` 的两种应答形态——裸字节流，以及 mobilecli 1.0.5 的 `{ format, sessionUrl }` 信封（会话 URL 必须留在回环栅栏内）——并把 multipart MJPEG 体在单一归一化边界下重新发出：丢弃非图像段（JSON 通知），帧字节原样保留。
- `GET /phone/ws/io` 升级 — 在 `/api` 信任栅栏之后转发 `device.io.tap` / `gesture` / `text` / `button` JSON-RPC；未信任的升级在协议协商前被拒绝。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `tokenTtlMs` | `30000` | 已签发采集 URL 的有效期。路径前缀、HMAC-SHA256 与 loopback 采集栅栏不可配置。 |

## 扩展点

组合必须提供 `phoneDevices` 与 `webServer`；fiber 会等待二者。`./invariant` 伴生体为空，因为 Host WebServer 的 effect 持有路由注册与注销。

## 模型体验

无模型体验：本包是纯 Host 侧反代，不注册任何提示词、工具模式或其他模型可见面。

#### KV 缓存影响

与模型请求无关：插件只注册 Host HTTP 与 WebSocket 路由，从不写入会话事件，因此前缀复用与缓存行为不受影响。

## 已知限制与后续工作

- **采集 URL 仅限 loopback** — 即使是受信任的 LAN Host 也会被拒绝，因此非 loopback 部署在后续票补上已鉴权远程路径之前无法播放设备视频。
- **无 GUI** — 本包不渲染 `react-device-view`，也不强制 1:2 画面比例；ui-phone 稍后消费已签发 URL。
- **mobilecli 仍需用户安装** — `phone-runtime` 仍持有二进制发现与启动；没有该 Service 时本 Consumer 无法组合。
