# Agent Note: Side Chat 自有准入与头部操作

Status: implemented

[English](2026-08-24-side-chat-owned-admission-and-header-actions.md) | 中文

## Problem

Side Chat 复用标准 Session 对话 UI，但其子 Agent 归 subagent routing 所有。通用 Session RPC 会拒绝该身份，而打开临时标签页又不能创建 Agent。若把临时 renderer 身份当成持久 subagent，用户尚未发送消息时父会话计数也会变化。头部操作及其文档局部弹层还默认拥有完整对话宽度，放进右侧栏后会被裁切。

## Decision

`SessionAdmissionAdapter` 承载所有依赖 Session 归属的准入操作：提示词、取消、排队消息变更、命令处理、skill catalog 寻址与模型路由。Side Chat 适配器通过 `dsh-better-sidebar` 路由提供这些操作。首次提交之前，skill catalog 使用父 Session，模型选择保留在 renderer；首次提交以临时 id 创建子会话，并使用父 Agent 当时的选项。权限命令把 preset 应用到在线父会话和已发布子会话；临时子会话在创建时取得更新后的父会话选项。

临时摘要携带显式标记。Side Chat 分类器会识别该标记或保留标题，而后代索引会在 Host 发布 Session 之前排除该标记。发布后，持久 origin 与 parent 字段成为权威事实。

共享 composer 的加号按钮会在既有分组菜单中打开 `/` trigger 下的所有已注册 source。Side Chat 继续省略标题和面包屑导航，并把当前渲染 child 的下级目录作为第一个头部操作，后面依次是后台任务与定时任务。选择下级会重定向显式 Side Chat renderer，而不是调用外壳级 subagent 打开器；标签页会保留根 child id，用于释放在线句柄。后台任务和定时任务列表通过 viewport portal 渲染，右边缘跟随触发器，左边缘钳制在 viewport 内。

## Alternatives considered

**让嵌入式子会话使用普通 Session RPC。** 未采用，因为这些路由并不拥有 subagent Agent，其归属校验拒绝请求是正确行为。

**打开标签页时就创建子会话。** 未采用，因为查看空 Side Chat 不应占用运行资源，也不应在没有用户消息时改变持久拓扑。

**单独实现 Side Chat composer 与头部组件。** 未采用，因为这会重复标准对话包已经拥有的 queue、权限、技能、模型、transcript 与无障碍行为。

**在 Side Chat 隐藏不支持的控件。** 未采用，因为 queue steering、权限、技能、下级导航、后台任务与定时任务都有按 child 确定范围的归属方，经显式路由后可以继续复用共享 UI。

## Consequences

Side Chat 只有一棵标准对话组件树和一条功能自有准入路径。打开标签页在首次提交前不会改变拓扑；模型与 catalog 交互也不会发布 Session。权限变更与直接父会话保持同步，queue 编辑与 steering 会到达在线 child inbox。紧凑头部只展示当前渲染 child 的下级；选择下级时外壳主 Session 与 Side Chat 标签页都保持不变，任务列表在窄侧栏中仍完整可见。新增的功能自有 Session 操作必须同时扩展适配器及其归属路由，不能回退到通用 RPC。

## Testing

运行时与包级测试固定适配器路由、临时拓扑排除、分组 trigger launcher、模型选择、queue steering、权限同步、child-scoped 头部操作、本地下级重定向、根句柄释放与 viewport 弹层位置。装配后的 Web replay 会打开临时 Side Chat，在创建 child 前读取预置 skill，提交首条消息，切换模型，将权限同步到父会话与子会话，并验证子会话 transcript。
