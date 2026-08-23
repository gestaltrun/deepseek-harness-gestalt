# DeepSeek Gestalt Mobile

[English](README.md) | 中文

这是当前 Installation 的 Mobile Account 与 Personal Pairing shell。GitHub 授权前，它通过 `@capacitor/device` 读取原生设备名称及 iOS 或 Android 平台，将该展示绑定到生成的 Account Session，展示双语数据保留说明，在应用外打开授权，并以 P-256 证明轮询 Platform。登录后，Mobile 会在本地解码粘贴或浏览器相机 QR 扫描得到的同一份完整端点邀请，创建 XKpsk3 消息 1 与消息 3，显示由已完成握手哈希派生的认证词，并轮询不透明 mailbox 等待 Desktop 确认。Desktop 创建 Mobile Relay credential 与随机 32 字节 attachment key，Platform 只登记 credential digest 并复制已鉴别 Installation 展示；Mobile 打开 Snow 密封的 grant 与 attachment key 后才启动有界 WSS。账号隔离的 IndexedDB 原子保存 Mobile grant、仅供 IK 使用的 96 字节 reconnect record，以及独立 attachment key。撤销与 Account 范围重置会擦除两项秘密记录。

入口只接受一套实际运行的生产身份，由 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL`、`VITE_PLATFORM_GITHUB_CLIENT_ID`、`VITE_PLATFORM_CREDENTIAL_REFERENCE`、`VITE_PLATFORM_DATABASE_IDENTITY` 与 `VITE_PLATFORM_IDENTITY_NAMESPACE` 提供。字段缺失、localhost、非 HTTPS origin 或回调不匹配会在本地存储、渲染或网络流量前失败。

共用 Mobile 入口内置 `@capacitor/browser` 与 `@capacitor/device` adapter。授权尝试准备完成后，继续按钮的用户激活会直接调用 browser adapter；入口没有 `window.open`、弹窗、当前上下文导航或携带 token 的自定义 URL 回退。Personal Pairing 页面让取消与仍在等待的 `getUserMedia` 竞速，并以 `@zxing/browser` 读取一个 QR 值；成功、失败、取消或卸载后会停止 decoder，并停止当前或稍后返回的每条相机 track。不支持的相机 API、权限拒绝、无相机、空结果、畸形链接、过期、重放与跨账号尝试都会显式失败；QR 与粘贴绝不会创建不同的邀请或握手路径。`IndexedDbInstallationAccountStore` 将所选数据库 identity 写入数据库名；原生打包负责提供稳定 WebView origin。缺少 `crypto.randomUUID` 会在渲染前失败，因为创建 Installation id 需要安全浏览上下文。

## 共享 Session 呈现

加密 channel 只传输一份 JSON Mobile projection：conversation 使用数组，turn index 使用 entry 数组，pending interaction 只包含 id、Session id、kind 与 domain payload。authenticated receiver 会在同步前拒绝非 JSON 值，再由唯一的本地 adapter 构造 Client Runtime 的 `SessionListState`、`WorkspaceView`、`ConversationSnapshot` 与 `PendingWait` presentation carrier。pending responder 调用同一 generation 绑定的 channel，并把 accepted 或 rejected receipt 返回共享 Approval 或 Ask User owner；Map、class 与 callback 都不会跨越 wire。

打包后的 Mobile 入口把列表／详情导航留在 `apps/mobile`，但既没有 Mobile Session 摘要模型，也没有 Mobile conversation-node router。Session 分组与支持键盘聚焦的行执行公共 `ui-workspace` presentation，终态 conversation node 则执行公共 `ui-conversation` keyed presentation。订阅式 clock 更新共享相对时间标签。tail history response 会替换权威 conversation；`loadOlder` 会发送最旧可见 sequence，并 prepend 通过连续性校验的 page。locale 与 light/dark theme 会进入共享 conversation、Tool、attachment、question 与 Workspace 实现。图片通过 `ImageGallery` 渲染；普通 Tool 名称使用 Desktop 内置 keyed roster，只有未知名称使用 `GenericToolCard`。Mobile 绝不挂载 Desktop columns、Settings、model selection、plugin configuration 或 terminal input。

打包入口 snapshot 会直接挂载生产 React composition，通过内存 transport 完成 Account lifecycle，并安装经过鉴权、绑定 generation 的 surface fixture。它会覆盖共用 Workspace、conversation、Tool、attachment、Approval、Ask User 与 composer owner，而不会给 `main.tsx` 增加 keyless 产品选择。该 snapshot 不运行 model round，既不证明真实 Desktop transport，也不证明原生 WebView 执行。`apps/mobile/prototype-companion` 与开发端口 5173/5174 都不是 Mobile 产品验收 origin。

`apps/mobile/src/companion-cache.ts` 是尚未接入入口的库：它按配对 Desktop 以 Personal Pairing seam 注入的 AES-GCM 密钥密封已打开的 Workspace/Session 元数据与 transcript，并把行存入由 `companionCacheDatabaseName` 命名的 IndexedDB 数据库（`${accountStorageNamespace(environment, accountId)}:companion-cache`），使账号切换把缓存和回执与配对密钥存储隔离开。附件字节、终端内容、spill 文件与凭据永不进入缓存。`CompanionUncertainOperationSettlement` 仅在 mutation 离开设备后写入 Operation Receipt，发送前查阅已有回执，通过 `query-operation-status` 对账未知回执，且永不重放 operation。

附件控制器会读取用户选择的浏览器 `File` 字节，用 attachment key 加密后清除本地副本，只把密文连同当前配对范围的授权上传到运营中的 HTTPS `remote-attachments` 路由，校验返回的一次性 capability，并只把有界 `offer-attachment` operation 交给 Encrypted Companion 发送方。由 runtime 所有的 permit 会把整个异步传输绑定到一个物理连接 generation；每个外部 await 以及 upload 和 send 都要求该 generation 仍处于已同步前台状态。mutation channel 会把 operation id 与 send completion 返回给 Mobile surface；surface 会关联 Desktop 确认、attachment 拒绝、Host 失败与重连 status，而不会把它们当作搜索结果。attachment 拒绝或 Host 失败会成为可见 alert。surface 只拥有一个尚未结算的 attachment operation：该 operation 处于 sending 或 uncertain 时，再次选择文件会在调用 channel 前失败；确认、拒绝、失败或对账 status 会释放该 operation id。如果 sender reject，或在该 generation 已失效后 resolve，`CompanionAttachmentDeliveryUncertainError` 会保留 operation id，surface 会显示 uncertain 状态，直到 `query-operation-status` 完成对账。Mobile 搜索把裁剪后的查询发给 Desktop，并且即使 Companion Cache 中没有对应 Session，也会展示每个关联的权威 Session id/snippet 对；缓存中的标题、Workspace 标签、摘要、transcript 与子串匹配绝不会标注或创建搜索命中。`operation-failed` 会保留 Host HTTP 状态、wire 校验失败、业务 code/message 或超时，并作为 Mobile 可见错误展示。

```sh
pnpm --filter @deepseek-ai/dsh-mobile build
pnpm --filter @deepseek-ai/dsh-mobile exec vite --host
```

Vite 通过 [`tsconfig.base.json`](../../tsconfig.base.json) 的 paths 解析工作区包，因此这些命令在源码平面上运行。Android 模拟器必须对 Vite 端口做 `adb reverse` 并打开 `http://127.0.0.1`；`10.0.2.2` 不是安全上下文，无法创建 Installation id。

## 已知限制与暂缓事项

- 实际运行入口选择 `SnowMobileHandshakeClient`、`SnowMobileAttachmentOwner` 与 foreground Relay lifecycle，不提供 keyless 或开发产品选择。入口要求 `VITE_REMOTE_RELAY_WSS_URL`、`VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS`、`VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS`、`VITE_REMOTE_RELAY_RECONNECT_DELAY_MS`、`VITE_REMOTE_RELAY_INBOUND_MAX_BYTES` 和 `VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES`，且都会在渲染前校验。credential-bound Relay ready metadata 会开始一次新的 IK 尝试；只有精确的 route、selector、Desktop/Mobile attachment id 与 generation 完成该尝试后，ciphertext 才能到达同步逻辑。
- Companion Cache 库尚未接入 Mobile 入口：composition 不会构造 `companionCacheDatabaseName`、注入 #31 配对派生密钥、应答 Desktop 的 `query-operation-status` 查询，也不提供 composer、离线回执或清除缓存 UI。
- attachment-bound Snow channel 拥有解码 projection 与 result，并且是 Companion mutation 的唯一 sender。它会把一个物理 generation 的 mutation 与 content adapter 原子绑定到 `MobileCompanionSurface`；旧 attachment 的 receiver、pending responder、prompt confirmation 或 channel 不能经 replacement dispatch。Companion major 3 会把权威 Session 与 Workspace 发现、带真实 Host running 状态的 conversation history、等待 confirmation 的 prompt 提交、取消、Approval 与 Ask User settlement，以及摘要校验后的历史图片字节送入共享 Web 展示。关联失败会 reject 待处理工作并保持可见；确认后的 mutation 会触发一次有界 history 与列表刷新。Session 创建仍不可用，因此 shipped entry 会隐藏 New Session 控件。
- `CompanionForegroundRuntime` 是 Relay start/stop 的唯一所有者：配对与可见性共用一条转移队列，进入后台会停止 WSS；成功的 `unpair()` 会丢掉 grant，因此之后的可见性变化不能再启动 socket。解除配对会运行每项自有清理；任一拒绝都会保留可见、未解决且可重试的失败状态，不会返回 ready 配对页面。每个物理 attachment 的 ready/lost 转移都会创建或失效一个同步 generation，transport error 也会清除 `socketOpen` 与 `synchronized`。在完成已鉴权同步前，Mobile 入口不会虚构 Desktop 名称、写死离线状态、Device Principal 或本地 Session。附件工作使用当前 generation 的 mutation permit，只上传密文，并通过加密 channel 发送返回的 capability；搜索结果与 Host 失败只来自关联的 Desktop result。此前已鉴权内容可在重连期间保持可见，但 Session mutation、搜索与附件控件会在当前 generation 重新同步前保持 disabled。Mobile 不提供后台通知投递；只有打开应用或回到前台后，它才会获知 Desktop 当前状态。
- 发布验收会在 Node 22 与 24、iOS Simulator WKWebView 和 Android Emulator WebView 中运行仓库内确切的 Snow JS/WASM 包。原生 WebView runner 会覆盖配对、重连、新临时密钥、双向传输、篡改、重放、乱序、跨配对与最大帧限制；本地 Vite 与 `prototype-companion` 不是该产品链路的证据。
- 原生 iOS/Android 工程生成与设备打包不属于本 shell；仓库内 composition 已包含 Capacitor 系统浏览器适配器与共用 WebView 账号生命周期。
