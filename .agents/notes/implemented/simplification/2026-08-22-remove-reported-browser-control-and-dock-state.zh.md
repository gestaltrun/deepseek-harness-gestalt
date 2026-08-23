# Agent Note: 删除报告式 Browser 控制权与 Workspace Dock 状态

Status: implemented

[English](2026-08-22-remove-reported-browser-control-and-dock-state.md) | 中文

## 问题

Browser Runtime 报告 `agent` 或 `human` 控制权所有者，并暴露 `takeover` 与 `returnControl`，但实时 `WebContentsView` 没有产生这些事实的指针或键盘事件桥。直接页面交互本就独立工作，因此报告式所有者描述了一个未实现的仲裁产品，却让每个 Provider、Workspace 快照、Remote、工具、fixture 与文档都承担相应状态。Browser Workspace 还持久化 `dockOpen`、`dockWidth` 与 `userCollapsed`，而 better-sidebar 已经持有每个 Session 的面板可见性与宽度。

修订号计数器承担不同职责。工具、Workbench chrome、Provider 恢复与清理可能并发修改同一标签页，所以删除报告式控制权不等于可以停止拒绝过期写入。

## 决策

Browser 页面与不可用状态不携带控制权所有者。Browser Runtime、Browser Workspace、生成的 Remote 与 `dsh-tool-browser` 均不暴露接管或交还控制权操作。`browser_input` 作为 Agent 合成输入保留，要求非空 URL 或文本，并推进标签页修订号。人在 Electron 直接展示的页面上仍可交互，但 Runtime 不把该交互投影为所有权。

修订号是唯一并发机制。`navigate`、`focus`、`input` 与 `close` 要求 `expectedRevision`；Provider 串行执行已接收操作，并用 `BROWSER_REVISION_CONFLICT` 拒绝过期写入。Workspace 快照保留每个标签页的最新修订号，并以状态版本 `3` 拒绝已删除的 payload 字段。

Browser Workspace 投影只包含持有的 Workspace 层级、活动身份与每标签页修订号。better-sidebar 持有工作台面板可见性与宽度。收起预览只展开当前侧栏标签，不写入 Browser 状态。

Browser Workspace 还持有隐式的 Profile 匹配复用。省略 `attach` 的创建在每个 Binder 内串行执行，并为该 Session 的共享 Profile 或同名持久 Profile 复用已打开的浏览器实例；临时 Profile 保持独立。Workbench 传递未解析的创建请求，不根据 UI metadata 推断 attach。

客户端组合通过显式的 `ui-browser/client` module-table 请求导入 `BrowserPageChrome`，使用 Workspace 包内允许内联的页面扁平化函数，共用 API Remote 结果解包函数，并消费 `ui-browser` 持有的 Browser 设置解析器。`OfficialBrowserTab` 渲染页面 chrome，并把空标签创建委托给 `OfficialBrowserBridge`；它没有直接创建恢复路径。

本决策取代 [Browser 控制权仲裁](../feature/2026-08-19-browser-control-arbitration.md)中的报告式所有权部分、[Session Browser Workspace](../feature/2026-08-19-session-browser-workspace.md)中的 Workspace Dock 字段，以及[工作台官方 Browser](../feature/2026-08-21-workbench-official-browser.md)中的 Dock 跟随规则。那些记录中的修订号、Session 隔离、页面 chrome、overlay 与过期列表决策继续有效。

## 考虑过的替代方案

**把真实页面事件连接到报告式所有权。** 拒绝，因为直接 `WebContentsView` 交互不需要所有权状态，而事件归因会跨 Chromium 输入、Runtime 状态、持久投影、工具与 UI 增加第二套生命周期，却不改变谁可以交互。

**随控制权一起删除修订号。** 拒绝，因为过期的 Agent 或 Workbench 写入会退化为静默的后写覆盖，而且 Provider 崩溃或重连提交会在没有共同版本的情况下与写操作竞争。

**保留 Dock 字段作为 better-sidebar 状态的别名。** 拒绝，因为两个持久化权威来源可能在 Session 切换与重新加载时产生分歧。展示状态在 better-sidebar 中只有一个所有者。

**保留客户端 attach 推断。** 拒绝，因为 Workspace Binder 会串行创建并持有权威的已打开 Profile 层级。UI metadata 可能缺失或过期，无法安全决定 Runtime 实例复用。

## 影响

Browser 工具集从 9 个操作缩减为 7 个，Workspace payload 版本 `3` 有意不兼容已删除状态；依赖接管、交还控制权或 Dock Remote 的代码必须改用页面修订号与 better-sidebar 展示状态。人在 Desktop 实时页面上仍可交互，但 Browser Runtime 不会把该交互作为事实暴露。

这次删除去掉了一个跨包状态维度与重复客户端 helper，同时保留多实例身份、Profile 隔离、收起预览、直接页面交互和乐观并发控制。钉住的侧栏只为自身快照源码生成声明，因此 Host 构建不会把依赖声明写到仓库源码旁边。Runtime、Workspace、Tool、connection fixture、Workbench、overlay、生成 catalog 与客户端 aggregate 测试锁定剩余行为。
