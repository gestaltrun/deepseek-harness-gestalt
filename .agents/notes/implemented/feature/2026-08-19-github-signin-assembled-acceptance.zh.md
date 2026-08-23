# Agent Note: Desktop 与 Mobile 的 GitHub 登录组装级验收

Status: implemented

[English](2026-08-19-github-signin-assembled-acceptance.md) | 中文

## 问题

Issue #30 要求 Desktop 与 Mobile 都能用 GitHub 登录 Platform Account。客户端切片——`PlatformAccountInstallation`、`DesktopAccountController`、双语隐私说明、Mobile Account 页面和 HTTP 路由——已在 mobile-companion 基线就位，各自有基于伪造 transport 的单元测试。工单仍缺的是组装级证据：两个真实安装对同一个真实 Loader 组合的 Platform 通过 TCP 登录、真实安装上的账号切换、登出时的选择性失效、开发/生产身份命名空间隔离，以及 Desktop Host 控制器（加密存储、重启恢复、刷新轮换）驱动真实 HTTP 而非伪造 transport。

## 决策

不改动任何生产接缝，在工单点名的两个接缝上补齐 REAL 组合验收测试：

- `packages/platform/platform-account-http/tests/assembled.spec.ts` 现在用一个组合启动两个 `PlatformAccountInstallation` 客户端（desktop 与 mobile 类型、独立存储）。两者都完成 GitHub 授权；随后 desktop 安装切换到第三个 GitHub 身份，证明 Platform 只吊销被替换的会话（通过共享失效总线的第二个 `PlatformAccount` 的 `trackConnection` 观察），且 mobile 会话保持有效。第一次 desktop 登录后，测试为该账号写入 pairing-key 与 receipt 材料；切换后这些值仍在第一个账号下存活，并在第二个账号下缺席。登出 desktop 安装只关闭它自己被跟踪的连接，并保留第一个账号的 pairing-key 与 receipt；mobile 会话存活到它自己登出。
- 同一文件在配对的生产侧（独立的 origin、OAuth client id、callback、凭证引用、数据库身份和身份命名空间，共用同一令牌签名密钥）启动第二个组合，证明开发会话的访问令牌与 P-256 proof 在生产侧以 `SESSION_REVOKED` 和 `access token belongs to another identity namespace` 被拒。
- `apps/desktop/tests/platform-account-real.spec.ts` 用生产形态的 `DesktopAccountController`——`EncryptedDesktopAccountStore` 上的 UTF-8 直通（不是 Electron `safeStorage`）、被 mock 的系统浏览器适配器、调度轮询——驱动真实 Loader + TCP Platform：同意门禁、打开的 GitHub HTTPS URL（S256、无 scope、固定 `redirect_uri`、无 token）、签名轮询到达 `signed-in`、从直通记录重启恢复、十五分钟 TTL 后的访问令牌轮换，以及登出后记录回到 idle 且被吊销令牌被 Platform 拒绝。

## 备选方案

**再用一个伪造 transport 扩展 Desktop 单元套件。** 否决：工单重开的阻塞点是真实 Platform 上的组装验收，状态机已由伪造覆盖。

**两个 spec 文件共享一个 Loader 启动辅助函数。** 暂缓：`jscpd` 只扫描 `packages` 与 `scripts`，且 desktop 组合选择自己的环境对和直通 safeStorage 适配器；为两处调用提取跨应用测试辅助函数会让应用 spec 耦合包测试布局。

**也让 Mobile React 页面驱动真实组合。** 暂缓：`MobileAccount` 从 `PlatformAccountInstallation` 快照渲染，安装的真实 HTTP 生命周期已按两种安装类型完成组装覆盖；页面级行为测试覆盖渲染与同意门禁。

## 后果

组装测试在回环 TCP 与伪造 GitHub provider 上证明：带同意门禁的登录、面向 desktop 与 mobile 安装的 PKCE S256 加固定 HTTPS callback 与签名轮询、无 scope 授权 URL、十五分钟访问与轮换刷新的 P-256 会话、每次一账号的安装切换且只吊销被替换会话、在切换后存活且在新账号下不可见的 pairing-key 与 receipt 材料、只失效本安装会话并在共享失效总线上的第二个进程内 `PlatformAccount` 上生效的登出、使用同一签名密钥时开发／生产身份命名空间以 `access token belongs to another identity namespace` 拒绝访问令牌，以及 Desktop Host 的同意、签名轮询至 signed-in、重启恢复、刷新轮换与登出。该测试中的 Desktop Host 存储是 UTF-8 直通，不是 Electron `safeStorage`。未改变任何运行时行为；生产接线（`apps/platform/src/boot.ts`、Desktop Host、Mobile 入口）未动。

单元与 snapshot 套件仍覆盖 `accountStorageNamespace` 字符串构造、作为 Remote Access 记录的个人配对存活、Desktop 与 Mobile 展示及双语说明文本、核心 PKCE／到期／proof 重放边界、`EncryptedDesktopAccountStore` 原子写与 Electron `safeStorage`、IndexedDB `CryptoKey` 解析，以及 Mobile React 页面渲染。

父 spec #27 下的真实部署仍要求受信任的 HTTPS origin、会丢弃 provider token 的真实 GitHub OAuth 交换、两个真实 Platform Instance，以及托管数据存储。

## 测试

`pnpm exec vitest run packages/platform/platform-account-http/tests/assembled.spec.ts apps/desktop/tests/platform-account-real.spec.ts`——组装 HTTP 用例加 Desktop Host 生命周期，全部通过回环 TCP 上的真实 Loader 组合 WebServer + PlatformAccount 与伪造 GitHub provider。既有单元套件（`apps/desktop/tests/platform-account.spec.ts`、`apps/mobile/tests/mobile-account.spec.ts`、`packages/platform/platform-account-client/tests/installation.client.spec.ts`）仍覆盖展示、`accountStorageNamespace`，以及用 `'personal-pairing'` 占位符表示的登出保留。真实 Personal Pairing 记录的 Remote Access 组装覆盖在 `packages/platform/remote-access-http/tests/assembled.spec.ts`。

## 关联

- Issue #30（父 spec #27）——Desktop 与 Mobile 的客户端 GitHub 登录。
- [Platform Account installation sessions](2026-08-17-platform-account-installation-sessions.zh.md)——这些组合所执行的会话与 proof 设计。
- [Desktop Host ownership of the Account lifecycle](../architecture/2026-08-16-deepseek-gestalt-desktop-host.zh.md)——Desktop Host 拥有系统浏览器授权与受保护的安装密钥。
