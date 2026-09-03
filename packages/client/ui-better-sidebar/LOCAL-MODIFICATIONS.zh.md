# 本地修改

相对 [UPSTREAM.md](UPSTREAM.md) 所钉提交的每一处分歧。产品行为属于 `@deepseek-ai/dsh-client-ui-workbench`，不属于这里。

1. **工作区包清单** — `package.json` / `tsconfig.json` / `tsconfig.dts.json` / 本文件 / `UPSTREAM.md` 由本仓持有。上游 `package.json` 名 `dsh-better-sidebar` 收成 `@deepseek-ai/dsh-client-ui-better-sidebar`；上游插件 id、Cordis 名称与设置命名空间仍为 `dsh-better-sidebar`，工作区版本跟随 monorepo 根。清单把上游运行时依赖映射为工作区 peer 与开发依赖，而 `react-icons` 仍作为打包依赖。`tsconfig.json` 的 project references 使用本仓路径（`../../core/session`，不是 `../../session/session`）。快照不是 `tsconfig.client.json` 工程：那些 references 会把宿主 `Context` 合并拉进客户端程序。
2. **`src/config.ts`** — `import z from 'schemastery'` 改为 `import z from '@deepseek-ai/schemastery'`。
3. **`src/context-types.ts`** — 上游 `CordisContext & SidebarContextShape` 交叉类型保留唯一的 `betterSidebar` Cordis augmentation。本仓加入具体的客户端连接与 Session 准入类型，以及 canonical Side Chat 组合所需的临时 Session 与 `uiRenderer` 接口。
4. **`src/invariant.ts`** — 按本仓 invariant 门禁重写 companion（`PACKAGE_NAME` 与本工作区包名一致）。
5. **`tsdown.config.ts` / `src/client/chunk-loader.ts`** — 客户端 factory id 使用工作区包名；Host/Client 构建面拆开 Node 库与浏览器分块；省略插件注册表用的 `client-registry.js` 通道；分块与客户端 externals 请求 `@deepseek-ai/cordis`。Node 库构建通过 `tsconfig.dts.json`（`noCheck` 与 `noResolve`）只把快照源码声明写入 `lib/types`，这样无需加入客户端聚合，也不会把依赖声明写到依赖源码旁边。
6. **`src/bundle-route.ts`** — `LIB_DIR` 固定为包内 `lib/`，而不是 `dirname(import.meta.url)`。源码启动（`tsx`）否则会去读 `src/client-terminal.js`，终端 / 编辑器 / mermaid 分块会 404。
7. **`src/client/BrowserView.tsx`** — 当 `ctx.get('workbenchBrowser')` 已发布时，标签页渲染官方 chrome。沙箱 iframe 仍是独立安装快照时的回退。
8. **`src/client/service.ts`** — `setPanelOpen(open)` 展开或收起右侧工作台。官方预览与首个 Agent 标签页使用它；仅类型的 `openTab` 不会展开。
9. **`src/client/TabBar.tsx` / `src/client/sidebar.module.css`** — 存在 `window.dshDesktop.chromeOverlayShow` 时，`+` 菜单在 Desktop 原生 overlay 视图里打开，而不是页内 `Menu`。Desktop 顶部 Workbench 与 36px Window Chrome 对齐，并且只用 `+` 后可伸缩的未占用空间拖动窗口；标签拖动期间，该空间会临时恢复为投放目标。底部 Workbench 与纯浏览器 `dsh web` 都不渲染窗口拖拽空间，Web 继续使用页内菜单、上游标签上下文菜单和 34px 标签栏。
10. **`src/client/Sidebar.tsx` / `src/client/state.ts` / `src/client/sidebar.module.css`** — 面板缩放保留会话滚动条的 gutter 和滚动能力，并在松手前把 thumb 设为透明，避免 Chromium 在滚动容器改变大小时闪出 overlay scrollbar。新 Session 面板从已启用的标签类型卡片开始，不再自动打开 Files 首页；布局清理只删除严格匹配的旧自动记录，保留用户创建的编辑器和文件标签。
11. **`src/client/index.tsx`** — Desktop overlay 文档（`data-dsh-desktop-overlay` / `?dsh-desktop-overlay=1`）不把快照 `Sidebar` 挂到 `document.body`。overlay 设置仍走 Host chrome 的设置席位。
12. **`src/sidechat-routes.ts` / `src/index.ts`** — Side Chat 活跃 Agent 句柄与待发送快照归属于单次插件激活。停机先关闭路由准入，等待已接纳调用完成，再清空待发送快照并释放全部句柄，之后插件才达到静止状态。
13. **`src/client/SideChatView.tsx` / `src/client/index.tsx` / `src/client/api.ts` / `src/client/subagent-detect.ts` / `src/context-types.ts` / `src/sidechat-core.ts` / `src/sidechat-routes.ts`** — Side Chat 标签页只保留子会话创建与生命周期。它先暂存 renderer 临时身份并通过 `uiRenderer.mountSession()` 挂载本仓 `conversation` slot，直到首次提交消息才以同一 id 创建 Host Agent 与 Session。临时行保持在 subagent catalog 与计数之外。首次准入会捕获父会话历史、安装临时模型与权限选择，并发布子会话。运行时准入适配器负责路由 prompt/cancel、queue/steer、权限、skill（技能） catalog 与模型操作，同时隐藏继承的 seed 前缀。快照自有的线程切换、提升工具栏、transcript 轮询、消息渲染器、composer、会话头信息路由、connection 镜像、相关 CSS 与未使用的本地化字符串均不存在。紧凑会话头省略 Session 导航与 preset 标签，当前 child catalog、job 与 schedule 按 child id 解析。选择后代会话会重定向显式 renderer，不改变 shell 选中项；标签保留其 Side Chat 根 id 以供生命周期清理，workbench terminal 则保留自身 scope。
14. **`src/git.ts`** — 显式选择的子仓库若不在当前发现结果中会直接失败，不会回退到第一个仓库并把写操作施加到错误的 checkout。
15. **`src/agent-opens.ts`** — `sidebar_open` 投递会隔离并移除发送失败的 WebSocket sender；每个请求会保留到至少一个已连接视图成功接收为止。
16. **`src/loopback-allowlist.ts` / `src/index.ts` / `src/client/browser.ts` / `src/client/BrowserView.tsx` / `src/prefs-shared.ts`** — Host 与 Client 共用同一个 loopback allowlist 解析器。安全说明区分默认的不透明来源沙箱，以及只授予显式白名单 loopback 页面自身来源的权限。
17. **`src/client/locales-zh-HK.ts` / `src/client/locales-zh-MO.ts` / `src/client/locales-zh-TW.ts` / `src/client/locales.ts`** — 繁体中文地区字典使用描述性 export 名称，避免本仓 zh/en fallback 对称门禁把它们误判成缺少对侧的 fallback 配对。澳门与台湾模块说明使用各自实际 locale。
18. **`src/client/intercept.tsx`** — 关闭对话文件打开接管时，produced-files turn tail 也继续由官方 `ui-deliverables` 持有；侧边栏 chip 不会绕过该设置。
19. **`src/client/state.ts` / `src/client/sidechat-restore.ts` / `src/client/service.ts` / `src/client/subagent-detect.ts` / `src/client/builtins/tabs.tsx` / `src/client/api.ts` / `src/sidechat-core.ts` / `src/client/SideChatView.tsx` / `src/sidechat-routes.ts`** — 按 origin 隔离的标签条丢失后，Side Chat 标签页从持久化 Session 数据恢复。apply 生命周期内的投影订阅会恢复已发布、未归档的直属子线程，但不会替换活动标签。Host 会让关闭与首次发布串行执行，并报告持久化身份；关闭操作会等待释放与归档完成后再移除标签页，客户端卸载会阻止延迟提交。本地墓碑覆盖投影延迟。`?dsh-sidebar-reset` 会跳过恢复，共享 core helper 持有根线程身份。
20. **`src/client/intercept.tsx` / `src/client/sidebar.module.css`** — produced-files 的「在文件夹中显示」动作使用独立的 `producedFolder` 类，重置原生按钮的边框与背景；此前与 `+N` 计数共用 `producedMore` 类，浏览器默认按钮样式会显露出来。
21. **`src/path-security.ts` / `src/index.ts` / `src/html-route.ts`** — 读取路由（`fs.read`、`/sidebar/file`、`/sidebar/html`）通过 `resolveReadablePath` 解析已存在的文件，不做工作区包含校验，因此显式打开的编辑器标签页、其 Markdown 图片与 HTML 预览对工作区外的文件也能工作。写入路由（`fs.write`、上传）、`fs.tree` 与 `fs.search` 仍保留包含校验。

22. **`src/client/sidebar.module.css`** — 右侧与底部工作台面板只使用 `contain: style`。`contain: layout` 会把 Desktop 上绝对定位的面板顶出视口，标签条落到屏外，官方页面因而盖住侧栏标签列表。
23. **`src/client/service.ts`** — 带 path 或 URL 的 `openTab` seed 若活动 pane 在底部树，会在 mint 之前落到右侧工作台。纯类型的 `+` 点击仍跟随菜单所在 pane。
