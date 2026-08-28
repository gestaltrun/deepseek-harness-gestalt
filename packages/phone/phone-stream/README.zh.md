# @deepseek-ai/dsh-phone-stream

[English](README.md) | 中文

手机 IO 与屏幕采集的同源 Host Consumer。插件注入 `phoneDevices` 与 `webServer`，注册一条 WebSocket 升级路由和签名 HTTP 采集路由，并发布 `ctx.phoneStream`。浏览器永不直连 mobilecli `:12000`：tap/gesture/text/button JSON-RPC 走 `/phone/ws/io`，MJPEG/H264 帧走由 `sessionFor` 签发的 Host 同源 URL。画面排版（固定 1:2，轴 3）是 GUI Consumer 的约定；本包只签发流 URL 并转发帧。

- `sessionFor(id)` — IO 升级路径以及签名的 `mjpeg` 与 `h264` URL，查询 token 在 `tokenTtlMs` 后过期。
- `POST /phone/session` — 为最新清单中存在的设备签发这些 URL；先执行 `/api` 信任栅栏。
- `GET /phone/stream/<id>/<mjpeg|h264>?token=` — 反代 `device.screencapture`。先执行 `/api` 信任栅栏，再执行 loopback Host 栅栏，最后校验 HMAC；过期、伪造或非 loopback 请求返回 403。
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
