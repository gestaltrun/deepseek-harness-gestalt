# DeepSeek Gestalt Mobile

[English](README.md) | 中文

这是当前安装的 Mobile 账号与个人配对 shell。它在 GitHub 授权前展示中英文数据保留说明，在应用外打开授权，以 P-256 证明轮询 Platform，只恢复经服务端确认的账号会话，并在不删除个人配对的前提下退出当前安装。登录后，Mobile 会在本地解码粘贴或原生 QR 扫描器得到的完整端点邀请，创建 XKpsk3 消息 1 与消息 3，显示由已完成握手哈希派生的认证词，并轮询不透明 mailbox 等待 Desktop 确认。Desktop 创建 Mobile Relay credential，Platform 只登记 digest；Mobile 打开 Snow 密封的 grant 后才启动有界 WSS。账号隔离的 IndexedDB 只保留 Mobile grant 与 WebView 重启后所需的 96 字节 Snow reconnect record。

入口只接受一套实际运行的生产身份，由 `VITE_PLATFORM_ORIGIN`、`VITE_PLATFORM_CALLBACK_URL`、`VITE_PLATFORM_GITHUB_CLIENT_ID`、`VITE_PLATFORM_CREDENTIAL_REFERENCE`、`VITE_PLATFORM_DATABASE_IDENTITY` 与 `VITE_PLATFORM_IDENTITY_NAMESPACE` 提供。字段缺失、localhost、非 HTTPS origin 或回调不匹配会在本地存储、渲染或网络流量前失败。

共用 Mobile 入口内置 `@capacitor/browser` 适配器，并在授权尝试准备完成后由继续按钮的用户激活直接调用。入口没有 `window.open`、弹窗或携带令牌的自定义 URL 回退。`IndexedDbInstallationAccountStore` 将所选数据库身份写入数据库名；原生打包负责提供稳定 WebView origin。

`apps/mobile/src/companion-cache.ts` 是尚未接入入口的库：它按配对 Desktop 以 Personal Pairing seam 注入的 AES-GCM 密钥密封已打开的 Workspace/Session 元数据与 transcript，并把行存入由 `companionCacheDatabaseName` 命名的 IndexedDB 数据库（`${accountStorageNamespace(environment, accountId)}:companion-cache`），使账号切换把缓存和回执与配对密钥存储隔离开。附件字节、终端内容、spill 文件与凭据永不进入缓存。`CompanionUncertainOperationSettlement` 要求完成前台同步后才发送任何 mutation；它仅在 mutation 离开设备后写入 Operation Receipt，发送前查阅已有回执，通过 `query-operation-status` 对账未知回执，且永不重放 operation。

```sh
pnpm --filter @deepseek-ai/dsh-mobile build
pnpm --filter @deepseek-ai/dsh-mobile exec vite --host
```

Vite 通过 [`tsconfig.base.json`](../../tsconfig.base.json) 的 paths 解析工作区包，因此这些命令在源码平面上运行。Android 模拟器必须对 Vite 端口做 `adb reverse` 并打开 `http://127.0.0.1`；`10.0.2.2` 不是安全上下文，无法创建 Installation id。

## 已知限制与暂缓事项

- 实际运行入口选择 `SnowMobileHandshakeClient`、`SnowMobileAttachmentOwner` 与 foreground Relay lifecycle，不提供 keyless 或开发产品选择。入口要求 `VITE_REMOTE_RELAY_WSS_URL`、`VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS`、`VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS`、`VITE_REMOTE_RELAY_RECONNECT_DELAY_MS`、`VITE_REMOTE_RELAY_INBOUND_MAX_BYTES` 和 `VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES`，且都会在渲染前校验。credential-bound Relay ready metadata 会开始一次新的 IK 尝试；只有精确的 route、selector、Desktop/Mobile attachment id 与 generation 完成该尝试后，ciphertext 才能到达同步逻辑。
- Companion Cache 库尚未接入 Mobile 入口：composition 不会构造 `companionCacheDatabaseName`、注入 #31 配对派生密钥、应答 Desktop 的 `query-operation-status` 查询，也不提供 composer、离线回执或清除缓存 UI。
- Remote Companion traffic 与附件 flow 不在此 shell 范围内。`CompanionForegroundRuntime` 是 Relay start/stop 的唯一所有者：配对与可见性共用一条转移队列，进入后台会停止 WSS；`unpair()` 会丢掉 grant，因此之后的可见性变化不能再 `start()` socket。每个物理 attachment 的 ready/lost 转移都会创建或失效一个同步 generation，transport error 也会清除 `socketOpen` 与 `synchronized`。任意 Relay ciphertext 都不能完成同步。`MobileNoiseCompanionReceiver` 只接纳由 attachment-bound Snow channel 解密的受支持 `foreground-sync` projection，且其 generation 必须匹配当前 runtime receiver；旧 attachment 的 receiver 不能授权替换 socket，也不能替换最后一次已鉴权投影。发布的 `main.tsx` 与 keyless 诊断 snapshot 都会调用 `mountMobileEntry`，由它构造该 surface 并提供给共用 Web 组件；该 snapshot 不是产品验收。snapshot 会让一个此前已鉴权的 Session 经历物理重连，并钉住 Session 创建、提示词、取消、审批、Ask User 回答和附件控件在当前 generation 完成同步前保持 disabled；最终发送控制器同样 fail closed。Mobile 不提供后台通知投递；只有打开应用或回到前台后，它才会获知 Desktop 当前状态。
- 独立安全评审与物理 WKWebView/Android WebView 执行仍是发布验收要求；本地 Vite 与 `prototype-companion` 不是该产品链路的证据。
- 原生 iOS/Android 工程生成与设备打包不属于本 shell；仓库内 composition 已包含 Capacitor 系统浏览器适配器与共用 WebView 账号生命周期。
