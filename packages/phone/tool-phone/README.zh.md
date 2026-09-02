# @deepseek-ai/dsh-tool-phone

[English](README.md) | 中文

这是 `ctx.phoneDevices` 的模型 Consumer。它把 `device_list`、`device_open`、`device_close`、`device_observe`、`device_act` 与 `device_screenshot` 注册为普通延迟工具。`device_act` 只接受封闭的 tap、swipe、type 或硬件按钮动作；没有任意 `adb` 或 shell 路径。`device_list` 与 `device_observe` 的应答每项携带 `id`/`name`/`kind`/`state`/`online`/`platform`。

只有 `phoneDevices.isReady()` 为 true 时，六个 definition 才存在。Consumer 订阅 generation readiness，在激活时注册完整集合，并在 generation 停止或替换前 dispose 完整集合。缺少 readiness 方法的树外 fleet 实现保留静态注册约定以维持兼容。

## 配置

`timeoutMs` 是每次调用的正安全整数协作超时，默认值为 `30000`。无效值会让插件加载失败。Consumer 依赖手机设备群 Service 与工具注册表；禁用 `toolSearch` 时注册会明确失败。

`tool_search` 返回匹配 schema，但绝不激活工具。eligibility 仍是发现与调度的唯一权威。工具不提供自定义 presenter，因此 Host 客户端沿用与其他普通工具相同的通用 MCP 风格工具卡路径。

`device_act`、`device_open` 与 `device_close` 在先前监听器返回 `allow` 后，默认走 `tools/pre-execute` `ask`。先前的 deny 或 ask 保持不变。`allowed-once` 审批会执行一次设备群调用；拒绝则设备无副作用。

已携带 `PhoneDevicesError` 代码（`PHONE_DISPOSED`、`PHONE_ABORTED`、`PHONE_TIMEOUT`、`PHONE_UNAVAILABLE`、`PHONE_UNRESOLVED`、`PHONE_PROTOCOL`、`PHONE_UPSTREAM`、`PHONE_DEVICE_NOT_FOUND`、`PHONE_REAL_DEVICE`）的设备群失败会以同一代码重抛为 `HarnessError`。`device_act` 把封闭的 tap、swipe、type 或按钮动作转发到 `phoneDevices.io`。swipe 使用 `phoneSwipeActions` 发布的 WDA gesture：定位 `pointerMove`、`pointerDown`、500 ms 按住、终点 `pointerMove`、200 ms 收尾、`pointerUp`。空 type 文本，或注入设备群缺少 `io` / `screenshot`，使用 `PHONE_UNSUPPORTED`。`device_screenshot` 仍要求注入 PNG 方法；实况 MJPEG/H264 采集仍由 `dsh-phone-stream` 负责。

## 模型体验

### 手机工具发现与结果

#### 模型看到什么

初始工具列表省略全部六个设备工具，并包含普通 `tool_search` schema。搜索设备能力会在持久结果中返回精确 schema；后续请求依据当前合资格的 deferred 定义重新验证这些名称。每个操作结果都把完整清单、观察、变更回执、封闭动作或 PNG 截图事实渲染为 JSON 文本。

#### Token 影响

发现会把选中 schema 加入搜索结果与后续请求头。每次操作都会把完整渲染的 JSON 结果加入 Session 历史。

#### KV 缓存影响

首次请求不把设备 schema 放入前缀。发现会改变下一次请求的工具列表；此后追加式结果在该变化后的前缀之后保留复用。

## 已知限制与后续工作

- 已交付的 Desktop 与 headless preset 不挂载本 Consumer，因此还没有无密钥组装 transcript 快照。发现重建由包测试通过 `systemPrompt.assemble` 证明；产品组合挂上这些工具后再补 snapshot。`device_screenshot` 仍要求注入 PNG 方法，对当前 mobilecli Service 会以 `PHONE_UNSUPPORTED` 失败，因为采集路径是由 `dsh-phone-stream` 持有的实况 MJPEG/H264 流。实况视频、签名流路由与 GUI chrome 仍在各自的包中。
