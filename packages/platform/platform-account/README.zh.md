# `@deepseek-ai/dsh-platform-account`

[English](README.md) | 中文

本包定义 Platform 账号身份及绑定到单个 Desktop 或 Mobile 安装的账号会话服务。`AccountService` 通过 `ctx.platformAccount` 拥有登录尝试创建、GitHub 回调完成、签名轮询、访问令牌刷新、当前账号读取、已鉴别当前安装读取、当前安装退出登录和连接跟踪。`currentInstallation()` 会随账号投影返回由提供方绑定的安装 id 与类型，因此其他能力无需读取账号表，也无需信任调用方自行声明的角色。

公共类型对账号、登录尝试、账号会话、安装和证明 JTI id 使用品牌类型。运行时 `AccountError` 为无效或过期尝试、无效或重放证明、过期或已撤销会话，以及携带秒级 `retryAfter` 的开放注册 `QUOTA` / `PLATFORM_CAPACITY` 失败提供稳定错误码；`./types` 子路径保持仅含类型。规格固定上限为每个账号 10 个在线 Desktop 安装、10 个在线 Mobile 安装，以及 20 条并发被跟踪连接。可选的共享 `PlatformCapacityState` 会拒绝新的登录，已建立会话仍可使用。

`loadOperatedPlatformEnvironment` 是产品入口 parser：它只接受一套完整生产身份，并拒绝本地 origin。`loadPlatformEnvironment` 仅供 example 与测试等范围受限的 composition 校验并选择开发／生产身份对。产品客户端通过部署所有的构建产物取得实际运行身份，不提供运行时开发 selector。

## 模型体验

无。Platform 账号状态不对模型可见，不增加消息、工具或提示词文本。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 账号删除、会话列表、远程退出、全部退出、恢复和身份关联不属于本服务。
- 个人配对是独立能力，`signOut` 永远不会删除它。
