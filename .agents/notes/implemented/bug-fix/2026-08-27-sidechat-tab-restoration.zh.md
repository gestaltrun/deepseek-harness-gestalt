# Agent Note: 从持久化 Session 恢复 Side Chat 标签页

Status: implemented

[English](2026-08-27-sidechat-tab-restoration.md) | 中文

## 问题

Side Chat 标签条存放在按 origin 隔离的 localStorage 中，而每个已提问的 Side Chat 都是持久化子 Session。Desktop 重启后可能绑定不同的本地端口，导致标签条状态丢失，但 Host 仍会列出这些子 Session。如果恢复所有已列出的子 Session，用户主动关闭的对话也会重新打开。

## 决策

活动 Session 会将标签条与已发布的直属子 Session 对账；只有持久化标题以 `Side: ` 开头且未归档的子 Session 才符合条件。缺少标签页的子 Session 会以非临时标签页形式回到活动 pane，但不会替换原有活动标签。空白子 Session 和仅存在于渲染器侧的草稿不会恢复。冷线程从最新的子会话自有 `request/header` 恢复模型路由；首次请求尚未产生时回退到创建 descriptor，临时草稿则继续使用在线父会话的路由。Host 会让关闭操作与已准入的首次提示词串行执行，从在线与持久化 Session 存储判断发布结果，并释放在线句柄。客户端通过 Workspace service 归档已发布的 Session，但不删除日志；尚未发送内容的草稿没有需要归档的 Session。只有这些操作成功后才会移除标签页；失败会被报告，标签页仍保持打开。插件卸载会等待在途关闭，但阻止它们延迟提交状态。随后，侧栏本地状态会记录已关闭的根线程，防止列表刷新在归档投影到达前重新打开标签页。`?dsh-sidebar-reset` 逃逸参数会在本次加载中禁用恢复。

## 验证

Client 测试覆盖候选分类、归档排除、嵌套根线程去重、活动 pane 放置、列表刷新幂等性、apply 生命周期订阅清理、品牌化 Session id、旧持久化布局、reset 逃逸参数、跨 Session 与插件卸载关闭行为、首次提示词串行化、释放重试、权威草稿分类与冷启动模型路由重建。无密钥组装级 Web 场景会清除按 origin 隔离的标签条、重新加载 Host 持有的 Session，并继续恢复后的线程。浏览器演示会在新端口重启 PR 的真实 Web Host，通过真实模型请求继续恢复后的 Side Chat，并在再次重启后验证已归档的 Side Chat 保持关闭。

## 考虑过的替代方案

**只依赖本地关闭墓碑。** 不采用，因为 origin 变化时，墓碑会随其余 localStorage 数据一起丢失。

**把完整侧栏布局持久化到 Host。** 不采用，因为恢复标签页只需要持久化 Side Chat 身份；把所有插件自有标签页 payload 移入新的 Host 格式会扩大存储约定。

**恢复所有带标题的 Side Chat 子 Session。** 不采用，因为关闭标签页会变成临时操作，每次重启都会重新打开它。

## 后果

已提问的 Side Chat 可以在 origin 变化后恢复，无需把通用侧栏布局迁出浏览器存储。关闭已发布的 Side Chat 也会把它从 Workspace 分组界面归档，但 Session 日志仍保持持久化。恢复依赖 Session 列表与 Workspace 归档基线，因此只有两份投影都到达后才会稳定。
