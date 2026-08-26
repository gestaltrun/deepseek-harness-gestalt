# Agent Note: Side Chat 标签页在重启后从持久化线程会话恢复

Status: implemented

[English](2026-08-27-sidechat-tabs-restore-from-durable-threads.md) | 中文

## Problem

Side Chat 线程是持久化子 Session（subagent origin、`Side: ` 标签），但引用它的标签条标签页只存在于按 origin 隔离的 localStorage 中。桌面端 Web Host 每次启动绑定操作系统分配的端口，重启即更换 origin，标签条随之失孤：subagent 会话因其目录枚举自 Host 端持久化会话数据而重现，侧边线程却没有回到 UI 的路径——它们被刻意排除在 subagent 拓扑之外（"tab-strip conversations, never topology"）——尽管其 transcript 仍在盘上。关闭标签页也只释放在线 Agent，因此被用户刻意关闭的线程数据同样原样保留。

## Decision

标签条与会话列表订阅源对账（`packages/client/ui-better-sidebar`）。当某个会话的侧栏状态激活时，`restorableSideThreads` 收集该会话已发布的直接侧边线程（subagent origin、`Side: ` 标签、非空白、非渲染器临时身份），`reconcileSideThreads` 为每个没有标签页的线程补开一个。恢复的标签页携带不含临时标记的 `meta.threadId`，现有视图路径因此直接挂载会话，现有 `sidechat.prompt` 路由承担线程的冷恢复。恢复落在活动 pane 中且不抢占其活动标签；空 pane 会激活第一个恢复的线程。恢复还会重新展开收起的面板使其可见——窄屏的全屏抽屉保持关闭（与 loadState 的首屏规则一致）。

用户关闭会为线程记下墓碑：`closeTab`/`closeFloatByTab` 把标签页根线程 id 追加到持久化状态的 `closedSideThreads`，对账永不复活有墓碑的线程。`?dsh-sidebar-reset` 逃逸参数在本次加载中跳过恢复，因此当挂起的标签页是侧边会话时，重置仍能打破挂载挂起循环。标签页 meta 的线程读取器从视图移入共享的 `sidechat-core` 模块，纯状态层因此无需引入组件即可读取线程身份。

## Alternatives considered

**桌面端 Web Host 固定或记忆端口。** 只修桌面端，且端口被占即失效；自定义端口运行浏览器 `dsh web` 仍有同样故障。无论如何，持久化线程列表都是更可靠的权威来源。

**把标签条持久化到 Host 端。** 仅为跨越 origin 变化而新增一套按会话的 UI 状态存储；线程数据本已持久且足够，相比从它对账没有额外收益。

**在 subagent 目录中列出侧边线程供手动重开。** 推翻已记录的 "never topology" 分类，且每次重启后用户的标签条仍为空；恢复必须是自动的。

**不设墓碑。** 被关闭的线程会在下次重启时复活——关闭只释放在线 Agent、从不删除持久化 Session，因此显式关闭必须跨越重启保持有效。

## Consequences

在侧边会话使用中重启应用会恢复其标签页及完整历史，线程可继续对话。恢复只做加法——标签条不会因线程离开列表订阅源而删除标签页——因此迟到的基线与重连抖动不会与用户的布局对抗。墓碑按会话存储、不设上限，但只随被刻意关闭的线程增长。该 vendored snapshot 在 `LOCAL-MODIFICATIONS.md` 中登记了这次分叉。包测试固定了收集器的过滤条件、对账的落点与幂等性、两条关闭路径的墓碑写入、旧持久化状态的 sanitize 往返，以及逃逸参数的跳过行为。
