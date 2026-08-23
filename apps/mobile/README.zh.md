# DeepSeek Gestalt Mobile

[English](README.md) | 中文

这是当前安装的 Mobile 账号与个人配对 shell。它在 GitHub 授权前展示中英文数据保留说明，在应用外打开授权，以 P-256 证明轮询 Platform，只恢复经服务端确认的账号会话，并在不删除个人配对的前提下退出当前安装。登录后，配对控制器会把粘贴或原生 QR 扫描器得到的完整一次性链接送入同一条已鉴权远程访问传输，显示认证词，并轮询由 Mobile 拥有的待确认 id，直到 Desktop 明确确认后才显示已配对状态。确认结果携带由配对密钥密封的 Mobile 专用 Relay authority；Mobile 密码适配器解封该 authority 并启动有界 WSS 生命周期，且不会收到 Desktop credential。

入口会在渲染前校验完整的开发与生产身份对：两侧分别通过 `VITE_PLATFORM_DEVELOPMENT_*` 或 `VITE_PLATFORM_PRODUCTION_*` 前缀提供 `ORIGIN`、`CALLBACK_URL`、`GITHUB_CLIENT_ID`、`CREDENTIAL_REFERENCE`、`DATABASE_IDENTITY` 和 `IDENTITY_NAMESPACE`，再由 `VITE_PLATFORM_ENV` 显式选择一侧。成对字段必须全部不同；缺失、未知、共享、非 HTTPS 或回调不匹配的配置会在渲染和网络流量前失败。

共用 Mobile 入口内置 `@capacitor/browser` 适配器，并在授权尝试准备完成后由继续按钮的用户激活直接调用。入口没有 `window.open`、弹窗或携带令牌的自定义 URL 回退。当 Capacitor Browser 不可用时，当前浏览上下文会导航到已准备的授权 URL，并由 `load()` 恢复仍有效的待完成登录。`IndexedDbInstallationAccountStore` 将所选数据库身份写入数据库名；原生打包负责提供稳定 WebView origin。缺少 `crypto.randomUUID` 会在渲染前失败，因为创建 Installation id 需要安全浏览上下文（`https:` 或 `http://127.0.0.1`）。环回双实例开发监听见 [`examples/local-companion-platform`](../../examples/local-companion-platform/README.md)。

开发入口在账号 signed-in 后绑定 Companion Cache：`companionCacheDatabaseName`（`${accountStorageNamespace(environment, accountId)}:companion-cache`）命名 IndexedDB 数据库，`bindDevelopmentCompanionCache` 把 Desktop 已确认的 Session 元数据恢复进空列表，并持久化后续确认。附件字节、终端内容、spill 文件与凭据永不进入缓存。`CompanionUncertainOperationSettlement` 仍仅在 mutation 离开设备后写入 Operation Receipt，发送前查阅已有回执，通过 `query-operation-status` 对账未知回执，且永不重放 operation。

```sh
pnpm --filter @deepseek-ai/dsh-mobile build
pnpm --filter @deepseek-ai/dsh-mobile exec vite --host
```

Vite 通过 [`tsconfig.base.json`](../../tsconfig.base.json) 的 paths 解析工作区包，因此这些命令走源平面。开发服务器把 `/v1`（含 Relay WebSocket）代理到 `VITE_PLATFORM_DEVELOPMENT_ORIGIN`，且不校验监听证书。Android 模拟器必须 `adb reverse` Vite 端口并打开 `http://127.0.0.1`；`10.0.2.2` 不是安全上下文，无法创建 Installation id。无法信任捆绑监听证书的 WebView 留在该 Vite origin；入口会把 Account、配对、授权与 Relay URL 改写到该 origin，配对链接仍使用 [`examples/local-companion-platform`](../../examples/local-companion-platform/README.md) 的 HTTPS 监听 origin。

## 已知限制与暂缓事项

- 生产配对在独立 Noise 评审接纳经过评审的握手提供方前保持不可用。只有所选 Platform 环境为开发环境时，`VITE_PERSONAL_PAIRING_KEYLESS=1` 才会选择真实开发控制器与明确标记为未评审的 keyless Mobile 握手。该模式还要求 `VITE_REMOTE_RELAY_WSS_URL`、`VITE_REMOTE_RELAY_ATTACH_TIMEOUT_MS`、`VITE_REMOTE_RELAY_HEARTBEAT_INTERVAL_MS`、`VITE_REMOTE_RELAY_RECONNECT_DELAY_MS`、`VITE_REMOTE_RELAY_INBOUND_MAX_BYTES` 和 `VITE_REMOTE_RELAY_INBOUND_MAX_MESSAGES`；所有字段都在应用渲染前完成校验。
- Companion Cache 使用开发 AES-GCM 密钥，而不是配对派生的产品密钥，也不提供回执对账或清除缓存 UI。
- `CompanionForegroundRuntime` 是 Relay start/stop 的唯一所有者：配对与可见性共用一条转移队列，一字节 Desktop resync 会调用 `synchronize()`，`unpair()` 会丢掉 grant，因此之后的可见性变化不能再 `start()` socket。无密钥开发以 `mobile-development-keyless` 附着，在存活附着后向 `desktop-development-keyless` 宣告，并仅在 `companionMayMutate` 时发送 Encrypted Companion 的 `create-session`、`submit-prompt`、`cancel-prompt`、`offer-attachment`、`settle-approval` 和 `answer-ask-user`。浏览区可以新建 Ungrouped Session 或命名第一个 Workspace；列表与会话只在 Desktop 确认结果或 transcript-page 投影之后更新。Remote Offline 仍可读缓存行并拒绝作曲器 mutation。附件 offer 复用配对范围的密封辅助函数与开发 capability；Desktop 投影 `fileName`/`alt`，不把附件明文放进 Relay。`settleCompanionInteraction` 要求前台重连与该同步。会话卡片提供 Desktop 已授权的每一个结算选项，并仅在 Desktop 正在 streaming 时显示取消；原生 APNs/FCM 登记与真机投递仍不在此 shell 范围内。
- 原生 iOS/Android 工程生成与设备打包不属于本 shell；仓库内 composition 已包含 Capacitor 系统浏览器适配器与共用 WebView 账号生命周期。
