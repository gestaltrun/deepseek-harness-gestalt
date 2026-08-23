# Agent Note: 显式 Session slot 挂载复用标准会话 UI

Status: implemented

[English](2026-08-23-explicit-session-slot-mounts.md) | 中文

## 问题

功能外壳可以在应用仍选中一个会话时持续展示另一个次级会话。普通 slot 树把所有 session scope 组件绑定到外壳选中项；若复制 transcript、会话头与输入框组件来渲染次级会话，就会产生第二套展示约定，并遗漏独立注册的会话操作。

## 决策

运行时以 `renderSessionSlot()`、ui-renderer 以 `mountSession()` 提供框架级入口，用于挂载一个已声明的非 root Session slot。挂载会解析指定会话的标配 props、打开其历史窗口，并在独立 React 根中渲染，同时不改变 `sessions.list.current`。既有声明账本、entry 边界、store、inject 接口与标准钩子绑定仍是该树内的权威。

Side Chat 使用其子会话 id 与 `{ renderMode: 'sidechat' }` 挂载已声明的 `conversation` slot。better-sidebar 包只持有线程创建、切换、提升以及生命周期 chrome。`ConversationSessionHeader`、已注册的会话视图与 `conversation.composer.bar` 提供标题、谱系、对话/轨迹标签页、transcript、操作项与 InputBar。继承的 fork seed 仍保持持久化，但 `owned-suffix` 准入适配器会在子会话 transcript 中隐藏它，并把 prompt 与 cancel 操作路由到 Side Chat Agent 生命周期。

session scope 的会话头贡献通过标配套件接收该显式 id。因此，subagent 谱系读取 Side Chat 会话的后代，schedule 读取该会话的 `schedules` 投影，后台任务读取 `jobsBySession[sessionId]`。better-sidebar terminal 不是会话头贡献；它仍由 workbench 标签页的 `SessionScope` 确定范围，不会因嵌入式会话挂载而隐式重定向。

## 渲染权限

普通子 slot 仍通过声明 entry 的 `renderSlot` prop 渲染。显式 Session 挂载需要注入的 `uiRenderer` 服务，会拒绝 `root` 与 root scope 目标，并在目标未声明或渲染器不支持时失败。这是一项功能外壳组合操作，不是第二套 slot 定义 API，也不是组件 import API。

## 考虑过的替代方案

**保留 Side Chat transcript 与输入框。** 拒绝，因为它会重复会话渲染、输入行为、工具展示、已注册的会话头操作与无障碍修复，并持续偏离主会话 UI。

**引入 `ConversationSurface` 包装层。** 拒绝，因为已声明的 `conversation` slot 已经组合 `ConversationSessionHeader`、`ConversationSession` 与 `conversation.composer.bar`；另一层包装只会为同一套组合重新命名，而不持有新行为。

**渲染前选中 Side Chat 会话。** 拒绝，因为侧边对话必须在不替换主会话选中项及其工作区和 workbench 状态的情况下保持可见。

## 后果

Side Chat 删除自有 transcript 映射、轮询、消息行与输入框 CSS，同时自动获得全部标准会话贡献。次级挂载拥有独立的 React 根生命周期与历史窗口，因此外壳必须在标签页变化或卸载时释放挂载。Side Chat Agent 不走普通会话 prompt 路由，因此仍需要功能自有的准入机制。terminal 范围仍是显式的 workbench 事项，而不是渲染器绑定的附带结果。

## 验证

渲染器测试固定显式会话绑定在主选中会话变化或消失时保持不变。运行时测试固定功能准入、prompt 与 cancel 路由，以及继承 seed 隐藏。Side Chat 组件测试固定准确的 `conversation` slot、子会话 id、sidechat 渲染模式、不变的主会话选中项与挂载释放。
