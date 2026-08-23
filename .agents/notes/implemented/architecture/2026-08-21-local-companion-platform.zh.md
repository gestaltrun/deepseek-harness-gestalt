# Agent Note: Mount a local two-instance companion Platform for product clients

Status: implemented

[English](2026-08-21-local-companion-platform.md) | 中文

## Problem

生产 Platform 监听挂载 Account HTTP 并迁移 Remote Access 表，但配对 HTTP 与 Relay WSS 在独立 Noise 评审完成前保持未挂载。已有的无密钥组装夹具能在进程内证明配对和双实例 Relay，可 Mobile 与 Desktop 产品入口仍缺少一个共享受信任 HTTPS origin、真实 Account 会话和非粘性 TLS 前端的环回组成。当 Capacitor Browser 不存在时，模拟器浏览器也无法完成 GitHub 登录，除非仍有效的待完成登录能在当前浏览上下文导航后恢复。

## Decision

[`examples/local-companion-platform`](../../../../examples/local-companion-platform/README.md) 是长期运行的开发监听。它绑定一个 `127.0.0.1` TLS 端点，把 `/v1/*` 和 Relay 升级在两个进程内实例间轮换，并共享内存中的 Account、配对权威和 Relay 路由存储。所选开发身份就是该 TLS origin；生产身份仍是已运营的 `www.gestaltrun.com` 对，以便客户端成对校验拒绝共享身份。该组成里的 GitHub 授权是同一 origin 上的 `/v1/account/oauth/github/development-complete`，并始终给出 `octocat` 公开身份。Desktop 在进程内完成该环回 URL，且不跟随 303 页面回跳。Desktop 的环回 Fetch 使用 Node `https.request` 和内存中的 Response，因为在 Electron 主进程里构造 Chromium `Request`、`Response` 或 `Headers` 会与正在等待 Settings invoke 的渲染进程死锁。Host 接纳 `beginLogin` 时不会把该 invoke 跨过 Account HTTP 一直占住。环回开发把 Account 记录写成仅所有者可读的文件字节，因为 `safeStorage.encryptString` 会在授权期间阻塞 Host。`LOCAL_COMPANION_PAGE_ORIGIN` 把非 `/v1` 路径反代到 Mobile Vite，使浏览上下文可以共享 TLS origin；当客户端能够出示捆绑证书时，TLS 前端会把该 Vite origin 改写为所选 HTTPS origin，以满足 Account 与配对 CORS。无法对该证书完成 TLS 的 Android WebView 改为打开 Vite origin：Mobile Vite 在关闭证书校验的情况下把 `/v1`（含 Relay WebSocket）代理到监听，Mobile 入口再把 Account、配对、授权与 Relay URL 改写到该页面 origin。配对链接仍打印所选 HTTPS origin。[`apps/platform/src/boot.ts`](../../../../apps/platform/src/boot.ts) 不导入该示例，也不导入 `DevelopmentKeylessPairingHandshakeProvider`。

当没有会话时，`PlatformAccountInstallation.load()` 会把仍有效的待完成登录恢复为轮询，并清除过期的待完成尝试。非原生 Mobile 入口会对已准备的授权 URL 执行 `location.assign`，以便返回后由 `load()` 继续；只有打包后的 Capacitor WebView 才使用 `Browser.open`。入口仍然没有 `window.open`、弹窗或携带令牌的自定义 URL 回退。Account 与 Remote Access 的默认 Fetch 实现绑定到全局，以便浏览器调用。

Loader 场景使用顺序熵，以及真实的 Desktop/Mobile Account 客户端与 Remote Access HTTP/WSS 客户端，证明同账号登录、默认关闭的手机访问、确认后的配对，以及一次加密 Relay 往返。

无密钥产品 Desktop 与 Mobile 共用 Relay 附着 id `desktop-development-keyless` 和 `mobile-development-keyless`。一字节入站帧是开发同步宣告；更长的帧是密封的 Encrypted Companion 消息。Desktop 由进程内开发权威确认 `create-session`、`submit-prompt`、`cancel-prompt`、`offer-attachment`、`settle-approval`、`answer-ask-user` 和 `query-operation-status`。prompt 先投影带 `streaming: true` 的用户行，再在两秒后投影助手行以及待结算的审批与 Ask User 卡片，除非先取消。Mobile 只在该确认或投影之后更新浏览列表与会话，可以命名第一个 Workspace，在 Remote Offline 时拒绝作曲器 mutation，从 Companion Cache 恢复 Desktop 已确认的 Session 元数据，并提供 Desktop 已授权的每一个结算选项。Mobile 浏览连接标签跟随 `companionMayMutate`。

## Alternatives considered

**在生产监听上挂载配对和 Relay。** 这会把未经评审的握手送到已运营 origin。生产进程保持 fail-closed。

**把所选 Platform origin 改成 `http://127.0.0.1`。** Account 与 Remote Access HTTP 只允许所选 HTTPS origin，配对链接也必须保持 `https:`。所选身份仍是 TLS 监听；只有页面 origin 上的流量会经 Vite 改写。

**只把待完成登录留在进程内存。** 同一窗口授权会丢掉五分钟尝试。恢复持久的待完成状态是产品恢复路径，而不是测试钩子。

## Consequences

开发者可以拉起一个环回 origin，供 Mobile 模拟器和 Desktop 无密钥标志使用，而不需要第二套云上 Platform。代价是未经评审的握手、内存存储和捆绑测试证书：该监听不是生产环境，也不能替代 Noise 评审、SLS 或 TestFlight/APK 验收。交叉引用：[双实例 Relay](2026-08-18-stateless-two-instance-remote-relay.md)，[无密钥配对验收](../testing/2026-08-19-personal-pairing-assembled-acceptance.md)。

## 测试

[`examples/local-companion-platform/tests/local-companion-platform.spec.ts`](../../../../examples/local-companion-platform/tests/local-companion-platform.spec.ts) 通过 Loader 启动真实 `cordis.yml`，并断言组装后的 transcript 以及对生产监听隔离的 grep。[`packages/platform/platform-account-client/tests/installation.client.spec.ts`](../../../../packages/platform/platform-account-client/tests/installation.client.spec.ts) 恢复或清除持久的待完成登录。[`apps/mobile/tests/mobile-entry.spec.ts`](../../../../apps/mobile/tests/mobile-entry.spec.ts) 在 Capacitor Browser 不可用时导航当前浏览上下文，并把环回 HTTPS Account URL 改写到 Vite 页面 origin。[`apps/desktop/tests/loopback-listen-trust.spec.ts`](../../../../apps/desktop/tests/loopback-listen-trust.spec.ts) 完成 303 授权且不拉取页面回跳 Location。[`apps/desktop/tests/remote-relay.spec.ts`](../../../../apps/desktop/tests/remote-relay.spec.ts) 在入站密文后保持开发 Desktop 附着，并记录开发同步帧。[`apps/desktop/tests/development-keyless-companion.spec.ts`](../../../../apps/desktop/tests/development-keyless-companion.spec.ts) 确认创建、延迟取消、附件、交互结算与状态查询。[`apps/mobile/tests/mobile-account.spec.ts`](../../../../apps/mobile/tests/mobile-account.spec.ts) 仅在 Desktop 权威同步后标记 Remote Online，并且只在确认后追加 Session 行。[`apps/mobile/tests/development-keyless-companion.spec.ts`](../../../../apps/mobile/tests/development-keyless-companion.spec.ts) 恢复缓存的 Session 元数据。
