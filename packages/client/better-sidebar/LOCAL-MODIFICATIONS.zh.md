# 本地修改

相对 [UPSTREAM.md](UPSTREAM.md) 所钉提交的每一处分歧。产品行为属于 `@deepseek-ai/dsh-client-ui-workbench`，不属于这里。

1. **工作区包清单** — `package.json` / `tsconfig.json` / `tsconfig.dts.json` / 本文件 / `UPSTREAM.md` 由本仓持有。上游 `package.json` 名 `dsh-better-sidebar` 收成 `@deepseek-ai/dsh-client-better-sidebar`；版本跟随 monorepo 根。`tsconfig.json` 的 project references 使用本仓路径（`../../core/session`，不是 `../../session/session`）。快照不是 `tsconfig.client.json` 工程：那些 references 会把宿主 `Context` 合并拉进客户端程序。
2. **`src/config.ts`** — `import z from 'schemastery'` 改为 `import z from '@deepseek-ai/schemastery'`。
3. **`src/context-types.ts`** — 快照从 `@deepseek-ai/cordis` 导入 `Context`，并通过本地 `CordisContext & SidebarContextServices` 交叉类型携带结构化服务接口。仓库 Cordis augmentation 只增加 `betterSidebar`，因此快照镜像不会与能力所有包的声明冲突。
4. **`src/invariant.ts`** — 按本仓 invariant 门禁重写 companion（`PACKAGE_NAME` 与本工作区包名一致）。
5. **`tsdown.config.ts` / `src/client/chunk-loader.ts`** — 客户端 factory id 使用工作区包名；Host/Client 构建面拆开 Node 库与浏览器分块；省略插件注册表用的 `client-registry.js` 通道；分块与客户端 externals 请求 `@deepseek-ai/cordis`。Node 库构建通过 `tsconfig.dts.json`（`noCheck` 与 `noResolve`）只把快照源码声明写入 `lib/types`，这样无需加入客户端聚合，也不会把依赖声明写到依赖源码旁边。
6. **`src/bundle-route.ts`** — `LIB_DIR` 固定为包内 `lib/`，而不是 `dirname(import.meta.url)`。源码启动（`tsx`）否则会去读 `src/client-terminal.js`，终端 / 编辑器 / mermaid 分块会 404。
7. **`src/client/BrowserView.tsx`** — 当 `ctx.get('workbenchBrowser')` 已发布时，标签页渲染官方 chrome。沙箱 iframe 仍是独立安装快照时的回退。
8. **`src/client/service.ts`** — `setPanelOpen(open)` 展开或收起右侧工作台。官方预览与首个 Agent 标签页使用它；仅类型的 `openTab` 不会展开。
9. **`src/client/TabBar.tsx` / `src/client/sidebar.module.css`** — 存在 `window.dshDesktop.chromeOverlayShow` 时，`+` 菜单在 Desktop 原生 overlay 视图里打开，而不是页内 `Menu`。Desktop 顶部 Workbench 与 36px Window Chrome 对齐，并且只用 `+` 后可伸缩的未占用空间拖动窗口；标签拖动期间，该空间会临时恢复为投放目标。底部 Workbench 与纯浏览器 `dsh web` 都不渲染窗口拖拽空间，Web 继续使用页内菜单和 34px 标签栏。
10. **`src/client/Sidebar.tsx` / `src/client/state.ts` / `src/client/sidebar.module.css`** — 右侧和底部面板只在各自可见时占用布局空间，因此拖动一个轴不会激活已关闭面板保留的尺寸。面板缩放保留会话滚动条的 gutter 与滚动能力，但在松手前把 thumb 设为透明，避免 Chromium 在滚动容器改变大小时闪出 overlay scrollbar。
11. **`src/client/index.tsx`** — Desktop overlay 文档（`data-dsh-desktop-overlay` / `?dsh-desktop-overlay=1`）不把快照 `Sidebar` 挂到 `document.body`。overlay 设置仍走 Host chrome 的设置席位。
