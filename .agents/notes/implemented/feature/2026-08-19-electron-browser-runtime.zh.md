# Agent Note: In-process Electron Browser Runtime

状态：已实现

[English](2026-08-19-electron-browser-runtime.md) | 中文

## 问题

Session 持有的 AI Browser 需要在 Desktop 上使用真实 Chromium 引擎。把 Tandem Browser 作为第二个 Electron 应用 spawn 会拆分进程与存储所有权，写入 DeepSeek Gestalt `userData` 之外，并且不能把另一个进程的 `WebContentsView` 嵌入原生 Dock。

## 决策

`dsh-browser-runtime-electron` 在本 Desktop Host 进程中实现 `BrowserRuntime`。命名 Profile 使用 `session.fromPartition('persist:session-…')`；临时 Profile 使用没有 `persist:` 前缀的临时 `session-…` partition，Chromium 只在内存中保存其身份并在关闭时丢弃 —— `dsh-browser-runtime` 中的 `browserTemporaryPartition` 与 `browserSessionNameFromPartition` helper 为所有 Provider 持有该方案。隐藏的离屏 `BrowserWindow` 持有 `webContents`，用于 create、navigate、observe、screenshot、focus、input、takeover、returnControl 与 close。截图使用 `webContents.capturePage`；页面文本使用 `executeJavaScript`。人工 `input` 走单一路径：聚焦 input、textarea 或 contentEditable 时使用插入脚本，否则发送 `char` 输入事件。插件仅在 `process.versions.electron` 已设置，或 Node 测试通过 `@deepseek-ai/dsh-browser-runtime-electron/testing` 安装 host 时加载（config 不含 Electron 字段）；在普通 Node 上组合会在加载时失败。Chromium persist partition 位于 Electron `userData/Partitions/<name>`；loopback API token 位于 `userData/browser-runtime`，绝不写入 `~/Library/Application Support/Tandem Browser`。

Tandem 仍是 HTTP 与 MCP 操作词汇，不是 sidecar 二进制。`listenElectronBrowserHttp` 把 sessions、tabs、navigate、input、page-content、screenshot、focus 与 destroy 复制到 loopback origin。navigate、input 与 focus 会把客户端的 `expectedRevision` 与引擎修订号比较，并返回引擎已提交的修订号；不匹配时为 409 `BROWSER_REVISION_CONFLICT`。Desktop Host 启动该引擎，向 Node Web Host 导出 `DSH_ELECTRON_BROWSER_ORIGIN` 与 `DSH_ELECTRON_BROWSER_TOKEN_FILE`；当任一 Host 环境变量存在时，Desktop 叠加层把 `dsh-browser-runtime-tandem` 挂载为 `sidecar: false` 的协议专用 HTTP 客户端。两者都缺失时叠加层保留确定性 Provider 并禁用 HTTP 客户端——有意缺席的 Host 不是错误配置；只出现其中一个变量时在加载期即失败。`command` 与 `cwd` 仍可选，供仓库内 HTTP fixture 使用，并在 `sidecar` 为 false 时于插件加载失败。生产环境从不启动 Tandem.app。客户端无论是否拥有子进程都会通过 HTTP 销毁剩余打开的 session。

Dock 仍是截图、标题与文本的原生窗格。它不嵌入第二个 BrowserView。headless 与浏览器 `dsh web` 继续使用 `dsh-browser-runtime-deterministic`。[Tandem provider Agent Note](2026-08-18-tandem-browser-runtime-provider.zh.md) 记录协议专用 HTTP 客户端。

## 考虑过的替代方案

**把 Tandem.app 作为子 Electron 进程 spawn。** 拒绝，因为产品所有权留在本 Desktop Host；第二个 Electron 应用会拆分 partition、userData 与 Dock 事实。

**在 Dock 中嵌入 live BrowserView。** 拒绝，因为 Dock 是 Session 持有的截图、标题与文本窗格；第二个视图会把页面身份从 Workspace 投影中拆开。

**在 Node Web Host 内加载 Electron Provider。** 拒绝，因为 `dsh web` 是没有 `process.versions.electron` 的 Node 子进程；Host 持有 Chromium，并向该子进程发布 Tandem 形态 HTTP。

**删除 tandem 包。** 拒绝，因为 HTTP fixture 测试与 Web Host 仍需要协议客户端；去掉 spawn 路径可以保留 Tandem 作为词汇，而不再使用 sidecar 二进制。

## 结果

Desktop 拥有真实页面，而不再使用第二个 Electron 应用。Web 与 headless 保持无密钥且确定性。Dock 继续渲染 Runtime 事实，而不是 live 视图。真实 Chromium e2e 通过 `pnpm run test:electron-runtime-e2e` 运行（[启动器说明](../testing/2026-08-20-electron-runtime-e2e-launcher.zh.md)）；Node 覆盖使用注入的 Electron host 与 HTTP fixture。

## 验证

- `pnpm exec vitest run packages/browser/browser-runtime packages/browser/browser-runtime-electron packages/browser/browser-runtime-tandem packages/browser/browser-runtime-deterministic --coverage`，并对每个包附 `--coverage.include='packages/browser/<pkg>/src/**/*.ts'`（逐文件 100%）
- `pnpm exec vitest run apps/desktop/tests/browser-runtime.spec.ts apps/desktop/tests/overlay-isolation.spec.ts packages/browser/tool-browser`
- `pnpm run test:snapshot`（browser-runtime 与 browser-runtime-tandem 的 headless transcript）
- `pnpm run typecheck`、`pnpm run build`、`pnpm run publint`、`pnpm run constraints`、`pnpm run doc-sync`
- `pnpm run test:electron-runtime-e2e` 在 Electron 内运行 `packages/browser/browser-runtime-electron/tests/runtime.e2e.ts`；Node 上的 `pnpm run test:e2e` 保留具名跳过：本进程不是 Electron，且不得 spawn Tandem.app。
