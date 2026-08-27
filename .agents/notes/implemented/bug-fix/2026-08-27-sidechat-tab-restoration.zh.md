# Agent Note: 从持久化 Session 恢复 Side Chat 标签页

Status: implemented

[English](2026-08-27-sidechat-tab-restoration.md) | 中文

## 问题

Side Chat 标签条存放在按 origin 隔离的 localStorage 中，而每个已提问的 Side Chat 都是持久化子 Session。Desktop 重启后可能绑定不同的本地端口，导致标签条状态丢失，但 Host 仍会列出这些子 Session。如果恢复所有已列出的子 Session，用户主动关闭的对话也会重新打开。

## 决策

活动 Session 会将标签条与已发布的直属子 Session 对账；只有持久化标题以 `Side: ` 开头且未归档的子 Session 才符合条件。缺少标签页的子 Session 会以非临时标签页形式回到活动 pane，但不会替换原有活动标签。空白子 Session 和仅存在于渲染器侧的草稿不会恢复。冷线程从最新 `request/header` 恢复模型路由；首次请求尚未产生时回退到创建 descriptor，临时草稿则继续使用在线父会话的路由。关闭已发布的 Side Chat 时，Workspace service 会归档其 Session，但不删除日志。侧栏本地状态也会记录已关闭的根线程，防止列表刷新在归档投影到达前重新打开标签页。`?dsh-sidebar-reset` 逃逸参数会在本次加载中禁用恢复。

## 验证

Client 测试覆盖候选分类、归档排除、嵌套根线程去重、活动 pane 放置、列表刷新幂等性、停靠与浮动标签页关闭、旧持久化布局、reset 逃逸参数、临时标签页关闭行为与冷启动模型路由重建。浏览器演示会在新端口重启 PR 的真实 Web Host，通过真实模型请求继续恢复后的 Side Chat，并在再次重启后验证已归档的 Side Chat 保持关闭。

## 考虑过的替代方案

**只依赖本地关闭墓碑。** 不采用，因为 origin 变化时，墓碑会随其余 localStorage 数据一起丢失。

**把完整侧栏布局持久化到 Host。** 不采用，因为恢复标签页只需要持久化 Side Chat 身份；把所有插件自有标签页 payload 移入新的 Host 格式会扩大存储 contract。

**恢复所有带标题的 Side Chat 子 Session。** 不采用，因为关闭标签页会变成临时操作，每次重启都会重新打开它。

## 后果

已提问的 Side Chat 可以在 origin 变化后恢复，无需把通用侧栏布局迁出浏览器存储。关闭已发布的 Side Chat 也会把它从 Workspace 分组界面归档，但 Session 日志仍保持持久化。恢复依赖 Session 列表与 Workspace 归档基线，因此只有两份投影都到达后才会稳定。
