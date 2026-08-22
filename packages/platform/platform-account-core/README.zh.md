# `@deepseek-ai/dsh-platform-account-core`

[English](README.md) | 中文

本包是 Platform 账号提供方。登录尝试有效期为五分钟，携带随机 OAuth state 与 S256 PKCE，只能凭签名轮询令牌和 P-256 安装证明消费一次。GitHub OAuth 适配器不请求 scope，拒绝继承得到的非空 scope，只保留不可变数字 id、公开登录名和头像，并在身份查询后丢弃提供方令牌。

完成新安装时，同一账号的第 11 个在线 Desktop 或 Mobile 会话会被拒绝；同一安装的再次登录会替换当前会话。`AccountBackend.consumeAuthorizedAttempt` 在插入会话的同一事务内统计该类型。`trackConnection` 通过后端解析未绑定会话，为每个账号接纳 20 个 closer，并在会话缺失、已停用或到达第 21 个 closer 时以 `QUOTA` 或 `SESSION_REVOKED` 拒绝。注入的 `PlatformCapacityState` 会以 `PLATFORM_CAPACITY` 拒绝 `beginLogin` 和正在完成的 `pollLogin`；`apps/platform` 启动时不会注入该水位。

账号会话把一个账号绑定到一个安装密钥及不可变的安装类型。访问令牌有效期为 15 分钟；刷新令牌在每次接受的使用中轮换，最长有效期为 30 天，且到期时间点本身已经无效。只有绝对期限内还能容纳完整 15 分钟访问令牌时才允许刷新，否则会在消费证明或轮换前拒绝。当前账号读取、当前安装读取、刷新和退出都要求新鲜且未重放的证明。安装读取会返回会话拥有的 id 与类型，而不是从调用方接收这两个值。持久化 Mobile 会话缺少 Installation 展示时，持久层允许 core 读取该记录；core 在验证证明后撤销它并返回 `SESSION_REVOKED`，客户端会清除本地状态，并要求以真实原生展示重新登录。替换、迁移或退出会话会先提交撤销，再等待失效投递。总线与每个实例都会分别隔离订阅方和连接关闭失败、运行全部回调，并汇总报告完成错误。

`loadPlatformEnvironment` 要求并选择完整环境对。开发与生产不能共享 origin、回调、GitHub OAuth App id、凭证引用、数据库身份或身份命名空间。提供方会在处理流量前拒绝与所选身份不匹配的 GitHub 适配器或后端。

## 扩展点

`AccountBackend` 提供原子持久化，`AccountInvalidationBus` 提供跨实例投递，`GitHubIdentityProvider` 拥有提供方交换。生产 composition root 提供三者；内存实现只用于无密钥验收与开发。

## 模型体验

无。账号授权位于 agent 会话与模型请求之外。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 本包不提供生产数据库、分布式失效、密钥管理、限流器或审计接收器；这些适配器归 Platform 部署 composition root 所有。
- GitHub 适配器只支持 OAuth Apps，并以无提供方 scope 的方式接收公开身份。
