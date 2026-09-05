# Agent Note: 显式 Session slot 挂载复用标准会话 UI

Status: implemented

[English](2026-08-23-explicit-session-slot-mounts.md) | 中文

## 问题

功能外壳可以在应用仍选中一个会话时持续展示另一个次级会话。普通 slot 树把所有 session scope 组件绑定到外壳选中项；若复制 transcript、会话头与输入框组件来渲染次级会话，就会产生第二套展示约定，并遗漏独立注册的会话操作。

## 决策

Slot 注册表负责准备一个已声明的非 root Session slot，ui-renderer 以 `mountSession()` 提供对应框架级入口。挂载通过 `UiSession.adapter.resolve(sessionId)` 解析指定会话的标配 props 并取得 render lease。首个 lease 调用 Session Controller 的 `openForRender()`；临时身份被 Host 发布升级时会再恰好打开一次，同时不改变 `sessions.list.current`。调用方销毁或 renderer teardown 会先卸载独立 React 根，再释放 lease。既有声明账本、entry 边界、store、inject 接口与标准钩子绑定仍是该树内的权威。

Side Chat 会预先分配子 Session id，并通过 `ctx.sessions.stageProvisional()` 以保留的 `Side: ` 标题将其暂存为仅供 renderer 使用的临时身份，然后以 `{ renderMode: 'sidechat' }` 挂载已声明的 `conversation` slot。该标题会阻止列表分类器与 subagent 自动激活把草稿当成委派任务，临时标记则让它保持在持久后代计数之外。打开标签页不会创建 Host Session 或 Agent。首次提交消息时才会以预分配 id 原子创建二者、捕获父会话历史、安装所选模型并准入提示词；Host 发布会原地升级临时行。better-sidebar 包只持有此子会话创建与生命周期，不提供标签页内的线程切换或提升 chrome。已注册的会话视图与 `conversation.composer.bar` 提供对话/轨迹标签页、transcript、操作项与 InputBar。`ConversationSessionHeader` 使用 Side Chat 形态省略 Session 标题、面包屑导航与 agent preset 标签，同时保留按 child 确定范围的下级目录操作和 Session 操作。继承的 seed 仍保持持久化，但 `owned-suffix` 准入适配器会在子会话 transcript 中隐藏它，并把 prompt、cancel、queue、command、catalog 与 model 操作路由到 Side Chat Agent 生命周期。

session scope 的会话头贡献通过标配套件接收该显式 id。Side Chat 会隐藏面包屑导航与静态 preset 上下文；下级目录操作读取当前渲染 child 的 catalog，schedule 读取该会话的 `schedules` 投影，后台任务读取 `jobsBySession[sessionId]`。选择下级会调用显式 renderer owner 的 `openSession` 回调，重定向同一个 Side Chat 标签页，同时保持 `sessions.list.current` 不变；标签页会保留根 Side Chat id，并在关闭时释放其生命周期归属方。better-sidebar terminal 不是会话头贡献；它仍由 workbench 标签页的 `SessionScope` 确定范围，不会因嵌入式会话挂载而隐式重定向。

模型选择通过 Session 级功能路由解析。首次提交之前，Side Chat 会根据共享目录验证并保留选择；创建子会话时会把该选择安装到新 Agent scope。发布之后，同一路由会更新活跃子 Agent，而不会调用被 subagent routing 拒绝的普通 Session 模型 RPC。

## 渲染权限

普通子 slot 仍通过声明 entry 的 `renderSlot` prop 渲染。显式 Session 挂载需要注入的 `uiRenderer` 服务，会拒绝 `root` 与 root scope 目标，并在目标未声明或渲染器不支持时失败。这是一项功能外壳组合操作，不是第二套 slot 定义 API，也不是组件 import API。

## 考虑过的替代方案

**保留 Side Chat transcript 与输入框。** 拒绝，因为它会重复会话渲染、输入行为、工具展示、已注册的会话头操作与无障碍修复，并持续偏离主会话 UI。

**引入 `ConversationSurface` 包装层。** 拒绝，因为已声明的 `conversation` slot 已经组合 `ConversationSessionHeader`、`ConversationSession` 与 `conversation.composer.bar`；另一层包装只会为同一套组合重新命名，而不持有新行为。

**渲染前选中 Side Chat 会话。** 拒绝，因为侧边对话必须在不替换主会话选中项及其工作区和 workbench 状态的情况下保持可见。

## 后果

Side Chat 删除自有 transcript 映射、轮询、消息行、输入框 CSS 与线程管理工具栏，同时自动获得标准会话视图与输入行为。紧凑会话头放弃标题与面包屑导航，使窄面板直接从视图选择开始，但当前渲染 child 的下级目录、schedule 与后台任务仍可使用。下级导航只改变显式挂载目标，因此主 Session、工作区和 Side Chat 标签页都不会因选择而消失。次级挂载拥有独立的 React 根生命周期；在临时阶段不会打开 Host 历史窗口，外壳必须在标签页变化或卸载时释放临时行与挂载。Side Chat Agent 不走普通 Session 路由，因此仍需要功能自有的准入。terminal 范围仍是显式的 workbench 事项，而不是 renderer 绑定的附带结果。

## 验证

渲染器测试固定显式 Session 绑定在主选中 Session 变化或消失时保持不变，并覆盖 typed `mountSession<K extends SessionSlotKey>(..., ownerProps: OwnerOf<K>)`。Session Controller 测试固定临时行存续、发布、释放与冷 `openForRender()`。会话头测试固定紧凑 Side Chat 形态：`renderMode: 'sidechat'` 省略面包屑导航，同时会话头操作项仍接收显式 owner。会话注释测试固定 SessionInput 的文本与图片标注动词、仅注释提交、Markdown 选区映射，以及不导入 `@deepseek-ai/dsh-client-runtime/client` 的 Chat store 草稿持久化。Side Chat 产品测试在 #591 完成前仍依赖 `packages/client/runtime`。组件测试固定准确的 `conversation` slot、子 Session id、sidechat render mode、外层工具栏与 preset 标签缺席、紧凑会话头操作项和标签页、不改变主 Session 选中项的本地下级重定向、根句柄释放、新建标签图标与文案，以及挂载释放。
