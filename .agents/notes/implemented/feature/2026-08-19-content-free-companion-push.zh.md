# Agent Note: Content-free Companion push and foreground deep links

Status: implemented

[English](2026-08-19-content-free-companion-push.md) | 中文

## Problem

进入后台的 Mobile Companion 如果没有唤醒信号，就无法察觉待处理批准、人工提问、回合完成或失败。若推送提供方收到 Session 文本、交互参数或设备身份，它就会成为另一个特权读取者。若通知操作凭过期界面直接结算交互，就可能在用户尚未看到当前状态时改写 Desktop。

## Decision

无内容推送属于远程访问，而不是独立的 Platform 通知总线。`@deepseek-ai/dsh-remote-protocol` 拥有提示记录、类别词汇、线解析器以及 APNs/FCM 投影。提示只携带 `approval` | `question` | `turn-complete` | `failure`、带品牌的 `routeId` 与可选的不透明 `sessionRef`。token 与 `sessionRef` 上限按 UTF-8 字节计。`companionPushHintForEvent` 对流式分片返回 `undefined`。解析器拒绝额外字段。

`@deepseek-ai/dsh-remote-access` 在 `RemoteAccessService` 上拥有 token 持久化与扇出。`registerPushToken` 与 `publishPushHint` 在提供方入口重新解析，因此带额外字段的提示到不了 outbox 或厂商载荷。`DesktopCompanionPushPublisher` 是 Desktop 必须调用的适配器：只有在批准、提问、回合完成或失败已经持久待处理后才发布，流式分片在该事件层被丢弃。单独撤销按账号与安装删除 token，即使 Desktop route 已经不在。关闭手机访问仍会删除被撤销 route 上的全部 token。

`apps/mobile` 拥有进程可见性。`CompanionForegroundRuntime` 是 Relay `start()`/`stop()` 的唯一所有者：配对与可见性共用一条转移队列，进入后台调用 `stop()`，回到前台的 `start()` 仅在 `isConnected()` 之后记录 `socketOpen`。Mobile 在 Desktop 权威 resync 密文到达后通过 `onCiphertext` 调用 `synchronize()`。`settleCompanionInteraction` 是唯一结算入口，并要求 `companionMayMutate`（前台 + socket 已开 + 已同步）。通知界面不能满足该闸门。产品 `unpair()` 会清除本地 token、调用 `configure(undefined)`、重置 `socketOpen`/`synchronized`，并在 route 仍存在时调用 `unregisterPushToken`。

每天 500 条提示的配额仍留在开放注册准入计数器上。配对 HTTP 消费方的发布与登记路由、原生 APNs/FCM 凭据以及真机 TestFlight/APK 证明不在本决策范围内。HTTP 客户端已发送 `unregister-push-token`；Platform 登记与发布路由仍暂缓，Desktop 也尚未监听 session 事件去调用 `DesktopCompanionPushPublisher`。

本决策落实[Mobile Companion 提案](../../proposed/feature/2026-08-17-mobile-companion.zh.md)的推送切片，但不把配对、Relay、附件与推送拆成浅服务。

## Alternatives considered

**把 `@deepseek-ai/dsh-remote-push` 做成 `ctx.remotePush`。** 被放弃的 WIP 已开始这个包。它会让 Push Hint 变成通用 Platform 总线，并拆开同一条远程访问生命周期。协议 codec 留在 `remote-protocol`；token 扇出留在 `remote-access` 内部。

**只在 `apps/mobile` 里做厂商载荷构造。** Platform 必须在不含 Session 内容的前提下发出 APNs/FCM 正文。协议投影是适配器与测试共用的边界。

**从通知操作直接结算批准。** 过期界面可能指向已经变化的工作。结算函数本身要求前台重连与 Desktop 权威同步。

**保持后台 WSS 或静默同步。** 受约束的移动后台执行不可靠，且 Expo Push Service 不在范围内。无内容唤醒加上前台重新同步是已接受路径。

**把辅助函数的返回类型当作结算闸门。** 深链辅助上钉死的 `settle: false` 不是强制。产品结算入口读取进程状态。

## Consequences

无密钥测试钉住载荷字节边界、流式不分发、提供方入口允许列表、先提交再发布、在没有存活 route 时按账号与安装删除 token、产品解除配对时清除 grant、串行化的 Relay start/stop、经 Mobile 入口 `onCiphertext` 路径的 Desktop resync `synchronize()`、针对 transport 替身的 APNs/FCM 适配器、真实 Mobile 入口可见性停止 Relay 生命周期，以及同步前拒绝结算。原生厂商凭据、HTTP 登记/发布路由、Desktop 调用 `DesktopCompanionPushPublisher` 的 session 事件监听器、持久 PostgreSQL token 存储以及设备级 APNs/FCM 仍是具名覆盖缺口。
