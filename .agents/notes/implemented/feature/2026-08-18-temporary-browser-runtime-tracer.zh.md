# Agent Note：临时 Browser Runtime tracer

状态：已实现

[English](2026-08-18-temporary-browser-runtime-tracer.md) | 中文

## 问题

浏览器控制需要先建立与 Provider 无关的 seam，随后持久 Profile、多标签页编排、Electron 集成与 Browser Dock UI 才能独立演进。第一个垂直切片必须证明身份、操作顺序、延迟发现、持久化的模型可见事实、通用展示与生命周期释放，同时不要求浏览器安装、登录或 API key。

## 决策

`dsh-browser-runtime` 通过 `ctx.browserRuntime` 定义 create、navigate、observe、screenshot、focus 与 close 的 Service Definition 方法。Browser Profile、Browser Workspace、浏览器实例与标签页身份使用各自独立的 `Branded<B>` 类型，并作为一个 `BrowserTarget` 一起传递。打开与关闭状态携带单调递增修订号。写操作要求 `expectedRevision`；Provider 串行执行操作，并拒绝过期调用方，而不是在 Agent 与人并发操作时接受后写覆盖。

`dsh-browser-runtime-deterministic` 是首个 Provider。它接收临时与命名持久 Profile，每个 Profile 只有一个标签页。close 丢弃临时身份，并在 Provider 释放前保留命名 persist 映射。每个 Provider generation 都有独立 owner token，用于其权威 state reader 与同步 invariant validator。invariant 在首次加载与热重载时从当前 state 建立基线，随后在赋值前按 target 验证身份、精确修订顺序与终态关闭；拒绝后原 state 仍是权威来源。Provider 只识别配置的页面，返回确定性观察与 PNG 数据，并通过受容纳的提交后 fan-out 向普通 observer 发布每个已提交状态。释放阶段停止接收新操作、排空操作队列、关闭每个仍打开的 Profile，并丢弃 persist 记忆。配置负责身份前缀、fixture 页面与截图数据；截图必须是含 PNG signature 的非空 canonical base64，无效或有歧义的配置会在加载时失败。

`dsh-tool-browser` 是面向模型的 Consumer。六个普通工具定义使用 `deferLoading: true`。`tool_search` 通过现有延迟发现路径返回精确 schema，但不激活工具；当前 eligibility 继续控制发现与执行。每个结果都把模型可见的身份、修订号、页面、截图、焦点与关闭事实渲染到普通持久 `tool/result` 中。请求头已经记录组装后的工具 schema，因此 Session 日志无需新增 Session 事件即可重建已发现 schema 与 Browser 事实。Consumer 不提供展示方法，让 Host 客户端继续使用通用工具卡路径。

无密钥 headless 示例挂载随仓交付的 base 与 headless profile、确定性 Provider、Consumer 与 replay adapter。它执行发现和完整 tracer，释放 Loader 树，然后重新加载同一个 Session 并验证 deferred schema 重建。共享 fixture runner 通过观察 `agent/created` 与 `agent-loop/config-start-failed` 等待异步配置 Agent 恢复，避免快速 Provider 与重启驱动发生竞态。

## 考虑过的替代方案

**把工具搜索视为激活。** 拒绝，因为发现是模型可见证据，而 eligibility 是现有授权与调度权威。激活集合会引入重复的可变状态。

**使用新 Session 事件持久化 Browser Runtime 状态。** 本 tracer 不采用，因为到达模型的每个事实已经位于持久工具结果与请求头中。未来产品投影若存在模型 transcript 之外的读取方，可以再证明其状态事件的必要性。

**添加 Browser 专用对话卡片。** 拒绝，因为产品决策是让 Browser 工具像普通 MCP 工具一样展示。专用卡片会在 Browser Dock 工作负责该体验之前提前创建 UI 行为。

**从原生 Electron 自动化开始。** 拒绝，因为这会在一个改动中混合能力接口、操作系统后端、持久化策略与 UI 投影，既无法无密钥重放，也会掩盖最小可用 seam。

## 结果

仓库具备完整 Browser Runtime 能力 seam，其接口、确定性 Provider 与模型 Consumer 可以独立演进。Session 重放能够重建模型获得的事实，并发写操作有明确冲突结果，终态身份不能复活，且提交后 observer failure 不能改变操作结果。确定性 Provider 是无密钥存储而非生产浏览器。命名持久 Browser Profile 通过该 seam 复用隔离 partition。Session 本地 Workspace 所有权见 [Session Browser Workspace Agent Note](2026-08-19-session-browser-workspace.zh.md)；原生 Electron 控制、Browser Dock UI、catalog policy 与迁移/发布工作仍属于独立功能。见[持久 Browser Profile Agent Note](2026-08-19-persistent-browser-profiles.zh.md)。
