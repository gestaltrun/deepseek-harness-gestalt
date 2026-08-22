# @deepseek-ai/dsh-browser-runtime-electron

[English](README.md) | 中文

这是服务临时、命名持久与共享 Profile 的进程内 Electron Browser Runtime Provider。它用本进程的 `session.fromPartition` 与页面 `WebContentsView` 实现 `ctx.browserRuntime`。截图使用 `webContents.capturePage`；首次出现 Chromium `UnknownVizError` 时，会在同一操作时限内等待一个动画帧并重试一次，其他截图失败和重试失败都会拒绝。页面文本使用 `executeJavaScript`。命名与共享 Profile 恢复 `persist:session-*` partition；临时 Profile 使用没有 `persist:` 前缀的临时 `session-*` partition，Chromium 只在内存中保存其身份，磁盘上不留任何可复用内容。Chromium persist partition 位于 Electron `userData/Partitions/<name>`，绝不写入 `~/Library/Application Support/Tandem Browser`。

插件仅在 `process.versions.electron` 已设置，或 Node 测试通过 `@deepseek-ai/dsh-browser-runtime-electron/testing` 安装 host 时加载。在普通 Node 上组合会在加载时失败。Desktop Host 把同一份 `webContents` 作为 `WebContentsView` 加到 Host `contentView` 上。不用子 `BrowserWindow`：对其调用 `setParentWindow` 会在 macOS Electron 41 上 SIGSEGV。

## 配置

| 字段 | 含义 | 默认值 |
|---|---|---|
| `idPrefix` | DSH 持有的不透明 Profile、Workspace 与浏览器身份前缀 | `electron` |
| `viewportWidth` | 页面未展示时用于截图的隐藏窗口宽度 | `1280` |
| `viewportHeight` | 页面未展示时用于截图的隐藏窗口高度 | `800` |
| `requestTimeoutMs` | 每次 Chromium 导航或内容读取的上限 | `30000` |

时长与视口尺寸必须是正安全整数。所有操作进入同一个串行队列。写操作要求调用方提供最后观察到的 `expectedRevision`。Agent 合成 `input` 走单一路径：聚焦 input、textarea 或 contentEditable 时使用插入脚本，否则发送 `char` 输入事件。换行在聚焦可编辑控件中是 U+000A；没有聚焦可编辑控件时，每个换行是 keyCode 为 `\\n` 的 `char` 事件。HTTP 适配器会拒绝没有非空 URL 或文本的输入。同一命名 Profile 的第二个打开写入方会以 `BROWSER_PROFILE_BUSY` 拒绝。共享 create 复用共享 partition，且不占用 `BROWSER_PROFILE_BUSY`。释放开始后的操作会以 `BROWSER_DISPOSED` 拒绝。释放阶段排空队列并销毁剩余隐藏窗口。

渲染进程崩溃会提交 reason 为 `crashed` 的 `BrowserUnavailableState`，并为同一 target 重建隐藏窗口。恢复耗尽则提交 `reason: 'reconnect-failed'`。格式错误的 Chromium 结果会以 `BROWSER_PROTOCOL` 拒绝。

`listenElectronBrowserHttp` 绑定一个 loopback HTTP 服务器，复制 Tandem 的 session、tab、navigate、input、page-content、screenshot、focus 与 destroy 操作，使 Web Host 可以驱动该引擎，而不嵌入第二个 Electron 应用。navigate、input 与 focus 会把客户端的 `expectedRevision` 与引擎修订号比较，不匹配时以 409 `BROWSER_REVISION_CONFLICT` 拒绝，并返回引擎已提交的修订号。

## 模型体验

通过 dsh-tool-browser 间接影响模型；该 Consumer 会渲染全部页面、截图、生命周期与可用性事实。

#### KV 缓存影响

Provider 自身不贡献请求文本；Consumer schema 与已记录结果决定缓存变化。

## 已知限制与后续工作

- `present` 把一个打开的页面贴到 Desktop Host 窗口上；`conceal` 只隐藏该页，不从 Host `contentView` 移除。`raisePresented` 在原生 overlay 视图收起后把该页抬到 Host chrome 之上。`loadURL` 在重定向后拒绝 `ERR_ABORTED`，或在 Chromium 已画出错误文档后拒绝网络错误，都视为已提交的导航。浏览器 `dsh web` 没有 Host 窗口，无法展示。
- 真实 Chromium e2e 通过 `pnpm run test:electron-runtime-e2e` 运行。Node 上的 `test:e2e` 记录具名跳过；单元测试通过 `@deepseek-ai/dsh-browser-runtime-electron/testing` 安装假 host，且从不 spawn Tandem.app。
- Desktop Host 在 macOS 与 Windows 上交付本 Provider。Linux 不在支持范围内。
