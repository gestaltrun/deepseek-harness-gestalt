# Agent Note: 原生 Browser Dock

Status: implemented

[English](2026-08-19-browser-dock.md) | 中文

## 问题

Session 可以拥有 Browser Workspace、实例、标签页、Dock 几何与当前控制权所有者，但 Session Surface 仍没有展示这些事实的原生窗格。再嵌入一个 Electron BrowserView 会把所有权拆给 Desktop Host。在对话历史里再放一个 Dock 会重复同一个占用方。

## 决策

`dsh-client-ui-browser` 把 Session 持有的 Browser Workspace 呈现为官方截图加文本 chrome。占用关系后来迁到工作台侧栏的 `browser` 标签；见 [工作台官方浏览器 Agent Note](2026-08-21-workbench-official-browser.md)。收起预览仍占用 `conversation.browser.preview`。实时事实通过 `useProjection('browserWorkspace')` 到达。变更走生成的 `remote.browserWorkspace` 命名空间，包括 `create`。

chrome 没有 Profile 切换或 Agent 状态行。工作台侧栏标签条就是页面列表；页面 chrome 没有标签条。持久 Profile 名称只出现在地址栏旁。活动标签页的标题、地址栏与截图会在该标签页的列表修订号前进时重新观察，因此 Binder 已提交的 navigate 会替换仍为空白的 `about:blank` 界面。刷新会先观察 Runtime 的当前 URL，再导航到该 URL。地址栏可编辑：回车导航，没有 scheme 的主机名会补上 `https://`。视口显示最近一次截图与页面文本，并在截图大于窗格时滚动；它不嵌入第二个进程。官方 chrome 不占用 `details`；窄屏浮层留给其他详情占用方（[窄屏浮层 Agent Note](../bug-fix/2026-08-21-narrow-browser-dock-overlay.md)）。

收起预览是同一批页面的单行分层摘要。点击后层会用该标签页在列表中的修订号聚焦它；点击当前层会通过 better-sidebar 展开工作台标签。后台标签页上的列表修订号冲突会 observe 一次并重试，或展示失败；该恢复由[列表过期 Agent Note](../bug-fix/2026-08-20-dock-listing-stale.md)持有。ChatView 在对话右侧留白窄于 240px 时隐藏预览。普通 MCP 工具行仍留在对话历史中。选中 `browser_*` 工具行会聚焦列表中的标签页；该路径由[对话浏览器工具聚焦 Agent Note](2026-08-20-chat-browser-tool-focus-dock.md)持有。[删除报告式控制权与 Dock 状态](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md)持有展示状态权威。

来自 [#60](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/60) 的 420/640/960 px 详情范围仍会导出，但官方 chrome 在工作台里时不再使用。切换 Session 会从 [#67](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/67) 持有的 Workspace 投影恢复该 Session 的可见性、宽度、实例、标签页、当前控制权所有者以及每个标签页最近一次提交的修订号。聚焦与关闭发送被操作标签页在列表中的修订号；该约定由 [Dock 标签页修订号 Agent Note](../bug-fix/2026-08-20-dock-tab-revision.md) 持有。

Web 与 headless 组合挂载 `dsh-browser-runtime-deterministic` 与 `dsh-browser-workspace`，使 Dock 拥有 Session 持有的 Runtime，而不需要 Electron。Host 组合同时插入 `dsh-tool-browser`；Web 组合会禁用该宿主平面行，让 standard、code 与 cordis preset 重新挂载它，行为与 `tool-web` 相同，并挂载 Dock 插件。Desktop Host 持有进程内 Electron `webContents` 与叠加层 HTTP 客户端；Dock 仍渲染截图、标题与文本，不嵌入第二个 BrowserView。

当聊天 store 没有选中项时，DetailsPanel（`id: 'tool'`）不渲染任何内容，因此除非选中了工具调用，详情列表保持为空。ChatView 总会请求 `conversation.browser.preview`，并在右侧留白放不下时隐藏该轨。页面视口会重绑定升高滚动条配对，因为它绘制 `--dsw-alias-bg-module-platform`，且页面文本叠层在其中滚动。

## 考虑过的替代方案

**嵌入 Desktop 持有的 Electron BrowserView。** 否决，因为 DeepSeek Gestalt 必须拥有 Dock 占用方；第二个进程会把页面身份从 Session Workspace 拆开。

**Dock 打开时仍在对话里保留第二张 live 卡片。** 否决，因为预览是同一 Dock 的重新打开路径，不是第二个 Dock。

**只把 Dock 打开状态与宽度存在 layout store。** 否决，因为每个 Session 必须在切换与重新加载后恢复这些事实。

## 后果

人与 Agent 在同一组 Session 持有的标签页身份上共享一个 Dock。收起是 Session 事实，因此后续 Agent 活动不能抢开该窗格。Web 与 Desktop 渲染同一个占用方；两者都不嵌入第二个 BrowserView。发布仍属于后续工单。

## 验证

- `pnpm exec vitest run packages/client/ui-workbench packages/client/ui-browser packages/browser/browser-workspace packages/client/ui-conversation/tests/preview-rail.client.spec.ts packages/client/ui-conversation/tests/chat-view.client.spec.tsx`
- `pnpm exec vitest run packages/client/ui-browser --coverage --coverage.include='packages/client/ui-browser/src/**/*.ts'`
- `pnpm run check:ci:static`
