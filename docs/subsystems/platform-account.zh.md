# Platform 账号

[English](platform-account.md) | 中文

[`@deepseek-ai/dsh-platform-account`](../../packages/platform/platform-account/README.md)定义 Platform 身份，以及绑定到一个 Desktop 或 Mobile 安装的持有证明账号会话。GitHub 只提供不可变的数字主体和当前公开登录名／头像；身份验证后会丢弃其 OAuth 令牌。

## 登录与会话生命周期

安装在创建五分钟 `LoginAttemptView` 前接受唯一规范的双语隐私说明。Mobile 会先准备登录尝试，再允许点击授权按钮；按钮的用户激活会直接调用 Capacitor Browser 适配器，Desktop 则委托 Electron `shell.openExternal`。系统浏览器使用带 S256 PKCE、随机 state、无 OAuth scope 的 Authorization Code，并返回唯一固定的 HTTPS Platform 回调。应用不会收到回调凭证或携带令牌的自定义 URL；只有 P-256 `AccountProof` 兑换单次使用的签名轮询令牌后，`LoginPollResult` 才会完成。

`AccountSessionView` 包含 15 分钟访问令牌和有效期最多 30 天的轮换刷新令牌。只有完整 15 分钟访问期限能落在该绝对限制内时才接受刷新；过晚的请求会在消费证明或轮换令牌前被拒绝。当前账号读取、刷新和退出都通过品牌化的单次证明 JTI 来证明持有安装密钥。不透明 `AccountSessionId` 是 Platform 实例之间共享的失效身份。

## 所有权与隔离

一个安装只持有一个当前 Platform 账号。账号域配对密钥、缓存和操作回执使用包含环境与账号 id 的命名空间，因此切换账号会选择隔离的材料。一个串行 lifecycle owner 会依次处理恢复、刷新、登录、轮询、切换与退出，重复加载不能清除或复活较新的会话。Desktop 关闭时会关闭该 owner、排空已经接纳的轮询，并抑制 dispose 后的状态变更或发布。快照 listener 的错误会分别隔离。当前安装退出会提交会话失效，分别隔离错误并等待全部失效 listener 与连接 closer，同时保留个人配对。

通用能力可以为范围受限的 example 与测试校验彼此不同的开发和生产身份。Desktop 与 Mobile 产品入口会在渲染或流量前只接受一套实际运行的生产身份：Desktop 从应用 archive 读取发布流程生成的公开配置，Mobile 则通过构建配置接收同一组字段。该身份绑定 HTTP Consumer 唯一的 CORS origin、客户端 transport、OAuth adapter、backend 数据库、本地存储、回调与签发账号命名空间；字段缺失、localhost 或 Consumer origin 不匹配会在注册路由前失败。HTTP 与持久化记录都会在各自边界从 `unknown` 解析，IndexedDB 只接受真正的 P-256 私有签名 `CryptoKey`。内存后端与失效总线是 fixture adapter；生产持久化与分布式失效属于 Platform 部署。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxplatformaccount--accountservice-abstract-seam"></a>

### `ctx.platformAccount` — `AccountService` (abstract seam)

Platform Account capability. Providers own OAuth, installation-key binding, token rotation, and current-installation invalidation behind this interface.

```ts cordis-catalog
/**
 * Start one GitHub Authorization Code attempt for an installation key.
 * @param input - installation identity, kind, and public P-256 JWK.
 * @returns the system-browser URL and signed polling capability.
 * @throws AccountError `PLATFORM_CAPACITY` with `retryAfter` when the shared watermark is shedding.
 */
abstract beginLogin(input: { installationId: InstallationId installationKind: 'desktop' | 'mobile' publicKey: JsonWebKey }): Promise<LoginAttemptView>

/**
 * Settle the fixed HTTPS GitHub callback; provider credentials never leave the provider.
 * @param input - GitHub authorization code and returned random state.
 * @returns completion marker suitable for a browser confirmation page.
 */
abstract completeGitHubCallback(input: { code: string; state: string }): Promise<{ completed: true }>

/**
 * Poll one attempt using both its signed polling token and installation proof.
 * Completing a new Installation is rejected at the tenth-plus-one live Desktop or Mobile session for that Account.
 * @param input - attempt binding and one-use proof.
 * @returns pending or the newly created Account Session.
 * @throws AccountError `QUOTA` or `PLATFORM_CAPACITY` with `retryAfter` seconds.
 */
abstract pollLogin(input: { attemptId: LoginAttemptId pollingToken: string proof: AccountProof }): Promise<LoginPollResult>

/**
 * Rotate a current installation's refresh token and issue a new access token.
 * @param input - current refresh token and installation proof.
 * @returns replacement tokens retaining the original absolute refresh expiry.
 */
abstract refresh(input: { refreshToken: string; proof: AccountProof }): Promise<AccountSessionView>

/**
 * Read the current installation account.
 * @param input - access token and installation proof.
 * @returns current account projection.
 */
abstract current(input: { accessToken: string; proof: AccountProof }): Promise<PlatformAccountView>

/**
 * Authenticate the Account and Installation identity bound to one current session.
 * @param input - access token and proof from the session's Installation key.
 * @returns provider-owned Account id, Installation id, and Installation kind.
 */
abstract currentInstallation(input: { accessToken: string proof: AccountProof }): Promise<AuthenticatedInstallationView>

/**
 * Revoke only the current installation Account Session.
 * @param input - access token and installation proof.
 */
abstract signOut(input: { accessToken: string; proof: AccountProof }): Promise<void>

/**
 * Track a Platform connection so cross-instance session invalidation closes it.
 * Unbound session ids are resolved through the Account backend; missing or inactive sessions are rejected.
 * @param sessionId - Account Session owning the connection.
 * @param close - idempotent close callback.
 * @returns disposer removing the tracked connection.
 * @throws AccountError `QUOTA` with a 60-second `retryAfter` when the Account already has twenty tracked closers.
 * @throws AccountError `SESSION_REVOKED` when the session is missing or inactive.
 */
abstract trackConnection(sessionId: AccountSessionId, close: () => void | Promise<void>): Promise<() => void>
```

Source: [`packages/platform/platform-account/src/index.ts:37`](../../packages/platform/platform-account/src/index.ts)
<!-- END GENERATED cordis-surface -->
