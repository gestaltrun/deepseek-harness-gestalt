# Agent Note: 工作台侧栏里的官方浏览器

Status: implemented

[English](2026-08-21-workbench-official-browser.md) | 中文

## 问题

第一期工作台快照关掉了快照 iframe 浏览器，官方 Session 浏览留在 `details` Dock。官方 chrome 画错了位置：右侧已被工作台 overlay 占用，折叠预览又坐在消息列下方，而不是对话右侧留白。用户 `+ → 浏览器` 也无法建页，因为 Client `remote.browserWorkspace` 没有 `create`。

## 决策

官方页面 chrome 挂在快照侧栏的 `browser` 标签类型上。每一个官方 Workspace 页面是一个侧栏标签。侧栏标签条就是页面列表。地址栏可编辑，回车即导航；observe 或 navigate 进行中时，刷新控件为 `aria-busy`。Desktop Host 把同一份 Runtime `webContents` 作为 `WebContentsView` 加到 Host `contentView` 上，用户可以点击、输入和滚动。设置弹层和侧栏 `+` 菜单与 `dsh web` 是同一套 React 组件；在 Electron 里它们挂在第二块透明 `WebContentsView` 上，叠在官方页面之上，`dsh web` 仍用页内面板和菜单。overlay 文档不调和官方页面，也不 present/conceal 实况页。未展示页面会继续挂在透明、屏外、不可聚焦的 `BaseWindow` 上，让 Chromium 持续绘制截图；展示时只把 `WebContentsView` 换挂到 Host，收起时再放回该绘制宿主。`loadURL` 在重定向后拒绝 `ERR_ABORTED`，或在 Chromium 已画出错误文档后拒绝网络错误，都视为已提交的导航，不是崩溃。不用子 `BrowserWindow` 加 `setParentWindow`，因为那条路径在 macOS Electron 41 上会 SIGSEGV。`dsh web` 画截图加文本；`about:blank` 截图不绘制，新建标签显示起始文案。`+ → 浏览器` 与 `browser_create` 都按 `ui-browser` 默认身份创建一个官方页面。Browser Workspace 串行创建，并且只在 Profile 与该身份匹配时复用已经打开的 Session 实例。空的 `+` 标签会调用 `ensureOfficial`；`OfficialBrowserTab` 没有直接创建回退。同一页面按 `ctx` 与 Session id 保留一组 Session 绑定的 Remote 方法，因此侧栏重渲染不会重启 observe 与截图。关掉侧栏标签即关掉该官方页面。

官方 Browser chrome 不占用 `details`。better-sidebar 持有每个 Session 的面板可见性与宽度；Browser Workspace 不存储展示状态。

折叠预览仍走 `conversation.browser.preview`。ChatView 把它画在对话滚动区右侧留白，挨着居中的消息列；右侧留白窄于 240px 时隐藏。点击当前层会调用 `workbenchBrowser.reveal`。

宿主 `browserWorkspace.create` 现为 `@Remote('create')`。Browser Workspace 的 client 出口持有 Remote 结果解包，因此 UI 包使用这个纯适配器时不会求值整套 Remote assembly。设置页仍然不建标签。快照 `BrowserView` 留在树上：发布了 `ctx.workbenchBrowser` 时渲染官方 chrome，否则 iframe 仍是独立安装的回退。`betterSidebar.setPanelOpen` 用来展开面板，不必为此伪造 URL。

## 考虑过的替代方案

**官方 chrome 继续留在 `details`，工作台并排。** 否决，因为两者都画在右侧，且用户要求离开 Dock。

**用连到官方 Runtime 的 live iframe 替换快照 `BrowserView`。** 否决，因为百度等站点拒绝被嵌入；Desktop 展示已有 Runtime `webContents`，而不是第二份文档。

**子 `BrowserWindow` 盖在侧栏视口上。** 否决，因为 `setParentWindow` 在 macOS Electron 41 上会 SIGSEGV。

**抬起 Host chrome `WebContentsView` 并在 HTML 里挖空。** 否决，因为 HTML `z-index` 盖不住旁边的页面视图，把 Host chrome 挖空会让会话变黑，菜单和设置仍压在页面下面。

**删除快照 `BrowserView`。** 否决，因为每次 `git subtree pull` 都会把文件带回来。

## 后果

产品里只有一个浏览器。ChatView 在右侧留白不够时隐藏预览。窄窗 details 浮层不是 Browser chrome 的依赖。[删除 Browser 控制权与 Dock 状态](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md)持有展示与创建复用权威。

## 验证

- `pnpm exec vitest run packages/client/ui-workbench packages/client/ui-browser packages/browser/browser-runtime-electron packages/client/ui-conversation/tests/preview-rail.client.spec.ts packages/client/ui-conversation/tests/chat-view.client.spec.tsx packages/browser/browser-workspace/tests/workspace.spec.ts apps/desktop/tests/browser-present.spec.ts apps/desktop/tests/chrome-overlay.spec.ts packages/client/ui-desktop/tests/desktop-chrome-overlay.client.spec.tsx packages/client/ui-layout/tests/app-frame.client.spec.tsx packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`
- `pnpm run test:electron-runtime-e2e` 在真实 Electron 进程中验证隐藏页面截图与 Profile 隔离。
- `DSH_COVERAGE_PARTITIONS=4 pnpm run check:ci:coverage` 覆盖全部变更过的 Browser 与工作台分支。
- `apps/web/tests/browser-dock.snapshot.ts` 固定收起预览，以及打开与刷新后的工作台页面 chrome
- `pnpm run check:ci:consumers` 会在所有构建态 Client 产物读取者结束后运行 Web 门禁。串行 HMR owner 会先完整恢复 build record 覆盖的产物，再由并行 Web 测试池读取。
