# Agent Note: GitHub Platform 账号与安装会话

Status: implemented

[English](2026-08-17-platform-account-installation-sessions.md) | 中文

## Problem

Desktop 与 Mobile 需要先建立一个 Platform 身份，个人配对与远程访问才能据此授权。单独一次 GitHub 浏览器登录并不能定义 Platform 保留哪些提供方字段、应用如何安全取得结果、并发 Platform 进程如何一致获知某个安装已经退出，或切换账号时是否会暴露上一个账号的配对密钥和回执。

两种安装形态也使用不同的可信存储。Mobile WebCrypto 可以在稳定 WebView origin 下持久化不可导出的密钥。Desktop renderer 的 origin 跟随 loopback Web Host，因此 renderer 存储无法跨启动拥有稳定私钥。

## Decision

`@deepseek-ai/dsh-platform-account` 是 Platform 账号与当前安装账号会话的服务定义。核心提供方在环境身份命名空间内保存不可变的 GitHub 数字 id，只刷新公开登录名和头像。OAuth App 请求使用随机 state 和 S256 PKCE，不携带 scope 参数；返回的非空 scope 会被拒绝，GitHub token 在 `/user` 返回公开身份后即被丢弃。

安装会启动一个五分钟登录尝试。GitHub 返回唯一固定的 HTTPS Platform 回调。应用不会取得 OAuth code 或提供方 token，而是使用签名、单次有效的尝试令牌与新鲜 P-256 证明轮询。轮询成功后为该安装创建唯一账号会话，并替换该安装更早的会话。访问令牌有效期为 15 分钟；刷新令牌在每次接受的使用中轮换，最长有效期为 30 天。只有完整 15 分钟访问期限能落在该绝对到期时间内时才允许刷新，否则会在消费证明或轮换前拒绝。当前账号读取、刷新和退出都要求带时间戳且防重放的证明；其 JTI 使用品牌类型，并在 wire 或随机源边界解析。

账号提供方先提交撤销，再等待 `AccountInvalidationBus` 发布账号会话 id。投递会分别隔离每个订阅方的同步抛错与异步拒绝；每个 Platform 实例也会运行全部连接 closer 后再汇总报告失败。退出只清除当前安装的授权。个人配对与账号域材料保留在包含环境和账号 id 的命名空间中；切换账号会选择另一个命名空间，而不会覆盖或共享上一个命名空间。

Desktop Host 拥有私钥、会话令牌、Electron `shell.openExternal` 调用和 `safeStorage` 加密的按环境文件。文件使用随机独占 atomic-write 同级文件与仅所有者可读的 rename 提交。renderer 只经 preload 取得账号快照和生命周期动词。Desktop 只在「手机配对」Settings 分区展示账号状态；普通侧边栏和 Session 交互保持不变。Desktop 关闭时会关闭并排空 lifecycle transition owner，进行中的轮询不能在 dispose 后变更存储或发布。Mobile 在 IndexedDB 中拥有不可导出的 WebCrypto 密钥；parser 要求真正的 `CryptoKey` 身份，以及私有 P-256 ECDSA 签名属性，composition 内置 `@capacitor/browser` 适配器。授权按钮激活前会先准备登录尝试，因此点击会直接调用原生浏览器 API，不使用弹窗或自定义 URL 回退。两种呈现都在授权前导入同一份完整中英文保留说明，并明确首个版本不提供账号删除。两侧的快照 dispatcher 都分别隔离每个 listener，并在后续 listener 运行后才汇总报告失败。

开发与生产使用不同的 HTTPS origin、固定回调、GitHub OAuth App、凭证引用、数据库身份和身份命名空间。通用能力 example 可以校验完整身份对，而 Desktop 与 Mobile 产品只在渲染或流量前接受实际运行的生产身份。Desktop 从应用 archive 读取发布流程投影的公开字段，Mobile 则通过构建接收同一身份。实际运行的值绑定 HTTP Consumer 唯一且必填的 CORS origin、客户端 transport、OAuth adapter、backend 数据库身份、本地存储、回调与签发身份命名空间。HTTP 响应、IndexedDB 记录与 Desktop 加密文件都有显式 parser。一个 lifecycle transition owner 串行化加载、登录、轮询、刷新、账号切换与退出。

## Alternatives considered

**把 OAuth code 或 token 重定向到自定义应用 URL。** 这会让应用 handler 成为凭证传输通道，并让重放与安装绑定更复杂。签名轮询使提供方回调与凭证都留在 Platform。

**把 GitHub token 当作 Platform 会话。** 提供方 token 的生命周期、scope 继承和撤销会变成 Platform 授权语义。独立的持有证明会话让 Platform 只保留公开身份，并能单独撤销一个安装。

**把 Desktop 密钥存入 renderer IndexedDB。** Desktop Web Host 使用端口可能变化的 loopback URL。Electron Host 存储为安装提供稳定所有者，并让签名材料离开网页内容。

**退出或切换账号时删除配对。** 退出会变成破坏性操作，并把身份授权与独立的个人配对关系混为一谈。账号域命名空间既保留材料，又不会让另一个账号看到它。

**开发与生产共享身份基础设施。** 客户端或凭证错误可能在另一个环境完成认证或持久化。分离身份会让跨环境接受在运行时流量前失败。

## Consequences

Platform 部署必须提供原子账号持久化、分布式失效、OAuth 凭证、签名密钥、审计保留和 HTTPS edge 行为。实际运行的监听进程与产品客户端只接受生产环境；[仅生产环境的发布 CI](../process/2026-08-20-platform-production-release-ci.md) 负责服务端限制，Desktop 与 Mobile 打包则把公开的实际运行身份投影进发布产物。规格固定的开放注册安装与连接上限由账号提供方执行（[开放注册配额](2026-08-19-open-registration-quotas-capacity.md)）。内存后端和总线是 fixture adapter，不是生产持久性。原生 Mobile 打包必须提供稳定 WebView origin；Mobile composition 自己拥有 Capacitor Browser 适配器。账号删除、会话列表、远程退出、全部退出、恢复、身份关联、个人配对与远程访问仍是独立能力。

## Testing

核心测试覆盖 PKCE／无 scope 授权、单次轮询、精确到期与最后一个完整访问窗口边界、证明重放、过晚刷新不改变状态的令牌轮换、完整环境绑定、回调 state、异步失效隔离与跨实例连接关闭。安装测试覆盖隐私门槛、串行重复恢复与刷新／退出、listener 隔离、品牌化证明 id、显式 HTTP 与持久化 parser、真正与伪造 `CryptoKey` 记录、账号命名空间隔离和退出保留。Mobile entry 覆盖通过 Capacitor Browser 适配器边界运行真实 composition，并在干净树上从源码解析 privacy 子路径；Desktop 覆盖排空进行中轮询的静默 dispose，以及符号链接替换、失败清理与并发原子写。Loader 测试会挂载真实 WebServer、账号提供方、HTTP Consumer、客户端 transport 与 TCP server，覆盖必填的所选 origin 绑定、P-256 header、JSON 解析、轮换、轮询与跨实例退出。`examples/platform-account/cordis.yml` Loader snapshot 记录 15 分钟／30 天生命周期与跨实例退出。[Assembled GitHub sign-in acceptance](2026-08-19-github-signin-assembled-acceptance.md) 记录双安装 Loader HTTP 登录、账号切换后 pairing-key 与 receipt 隔离、同一签名密钥下的身份命名空间拒绝，以及 Desktop Host 在 TCP 上的生命周期。
