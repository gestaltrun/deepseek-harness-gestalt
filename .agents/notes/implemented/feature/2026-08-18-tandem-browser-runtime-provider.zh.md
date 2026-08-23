# Agent Note：Tandem Browser Runtime provider

状态：已实现

[English](2026-08-18-tandem-browser-runtime-provider.md) | 中文

## 问题

Browser Runtime 能力目前只有一个无密钥确定性 Provider。驱动真实浏览器需要一个持有真实浏览器进程的 Provider：它要真实地经历并呈现进程崩溃，同时遵守 DSH 的进程与身份契约，并且不 vendor 上游源码。

## 决策

`dsh-browser-runtime-tandem` 是 Tandem 形态 HTTP Service Provider。生产环境的 Desktop 把它指向[进程内 Electron Browser Runtime Agent Note](2026-08-19-electron-browser-runtime.zh.md) 中的 loopback origin。它从不启动 Tandem.app。可选的 `command` 与 `cwd` 只启动仓库内 HTTP fixture 子进程。`sidecar: false` 在插件加载拒绝 `command` 与 `cwd`；生产环境的 Desktop 设为 `false`。它把 `baseUrl` 约束为绝对的 loopback HTTP origin，从 `tokenFile` 读取 bearer token，并在接收任何操作之前于 `startupTimeoutMs` 内轮询 `GET /agent/version` 与 `GET /status`。全部配置——`command`、`args`、`cwd`、`env`、`baseUrl`、`tokenFile`、`idPrefix`、`startupTimeoutMs`、`requestTimeoutMs`、`healthPollMs`、`pageSettleMs`、`reconnectAttempts`、`reconnectDelayMs`、`processGraceMs`、`maxResponseBytes`、`sidecar`——都是经过校验的插件配置；没有任何随部署变化的取值被硬编码。

协议保真仅限于固定 revision，并以 `TANDEM_UPSTREAM_REVISION` 与 `TANDEM_UPSTREAM_VERSION` 导出。使用的端点为 `POST /sessions/create`、`POST /sessions/destroy`、`GET /tabs/list`、`POST /tabs/focus`、`POST /navigate`、`POST /input`、`GET /page-content` 与 `GET /screenshot`，全部携带 bearer token 鉴权，并受 `requestTimeoutMs` 与 `maxResponseBytes` 约束。页面读取携带 Provider 自有的 `settleMs`/`timeout`/`minLength` 查询上限，因为上游路由在短静态页面上会等待其内部 10 秒的稳定窗口。固定 revision 不可能产生的响应——错误的结构、id 位置出现空字符串、超限响应体——会以 `BROWSER_PROTOCOL` 拒绝；传输与进程失败会以 `BROWSER_RUNTIME_UNAVAILABLE` 拒绝。

Provider 在一个 loopback HTTP origin 上接收临时与命名持久 Profile。命名 Profile 映射到一个 HTTP session 与一个 `persist:session-*` partition；临时 Profile 使用临时 `session-*` partition。DSH 持有的不透明 Profile/Workspace/浏览器身份由 `idPrefix` 派生。所有操作通过同一个队列串行执行；写操作按 HTTP 引擎校验 `expectedRevision`，不匹配则失败关闭。observe 与 page-content 采纳服务端修订号，使两侧持有同一把计数器。后续 create 失败时，已打开 Profile 的 origin 继续运行。释放阶段停止接收新操作、排空队列、销毁剩余 session，并在 `processGraceMs` 内 join 可选的 fixture 子进程。

`BrowserRuntimeState` 扩展出 `BrowserUnavailableState`（`status: 'unavailable'`、target、revision、reason 为 `crashed` | `unhealthy` | `reconnect-failed`、`reconnecting`），因为持有真实进程的 Provider 存在确定性 tracer 无法表达的失败形态：进程仍在语义上存在，target 身份仍然有效，服务可能恢复。子进程意外退出或健康探测失败会提交 `unavailable`，其 `reconnecting` 来自配置，随后最多尝试 `reconnectAttempts` 次重启；成功后以同一 target、下一修订号重新提交打开页面状态，重连耗尽则提交 `reconnect-failed`。不可用期间，针对该 target 的操作会以 `BROWSER_RUNTIME_UNAVAILABLE` 拒绝——投影绝不把过期的页面事实呈现为打开状态。两个新错误码 `BROWSER_PROTOCOL` 与 `BROWSER_RUNTIME_UNAVAILABLE` 分别承载响应格式错误与运行时丢失两类失败。

出处记录在包内 `UPSTREAM.md`（固定 revision、版本、MIT 许可证、零 vendor 源码、无本地修改）与 `THIRD_PARTY_NOTICES.md`（逐字的上游 MIT 声明；不分发任何上游代码）。来自交付研究的上游贡献候选：隔离 session 缺少默认 session 的网络安全栈与扩展加载；session registry 只在内存；缺少 close/forget/wipe 存储擦除的区分；257 个 MCP 工具需要 allowlist/profile；`GET /page-content` 需要可由调用方约束的稳定等待；API 默认绑定全部接口并启用远程访问；ownership/handoff 缺少事件流；Linux 支持为 best-effort。评估来源是 `.agents/research/2026-08-17-agent-browser-runtime-options.md`。

## 考虑过的替代方案

**vendor 或 fork 固定 revision 的 Tandem 源码。** 拒绝，因为集成面是 HTTP 协议；携带源码会把一个 Electron 应用的维护负担及其上游贡献候选引入本仓库。

**把崩溃的子进程当作 target 丢失（`BROWSER_CLOSED_STATE` 或 `BROWSER_NOT_FOUND`）。** 拒绝，因为 close 是终态回执，而崩溃进程的 target 是可恢复的；混淆二者要么让终态身份复活，要么对 Consumer 隐藏重连尝试。

**让操作在子进程恢复前以传输错误失败。** 拒绝，因为 Consumer 会在状态未知时重试；携带明确 reason 与 `reconnecting` 标志的已提交 `unavailable` 状态才是真实投影。

**通过 Tandem 的 257 工具 MCP 面驱动。** 本 Provider 不采用，因为 Browser Runtime seam 已拥有操作词汇；MCP 一跳会增加第二个工具面却不增加浏览器事实。

## 结果

能力 seam 获得了一个 Tandem 形态 HTTP 客户端，其失败模型可观察而非致命：Consumer 通过同一个 `BrowserRuntimeState` union 看到真实的不可用与重连状态。生产环境的 Desktop 通过该协议驱动进程内 Electron 引擎；测试运行在仓库内 HTTP fixture 上，且从不 spawn Tandem.app。命名持久 Browser Profile 复用 `persist:session-*` partition；临时 Profile 使用临时 `session-*` partition。Session 本地多实例与多标签页所有权见 [Session Browser Workspace Agent Note](2026-08-19-session-browser-workspace.zh.md)；同一标签页上的人工与 Agent 控制权见 [浏览器控制权仲裁 Agent Note](2026-08-19-browser-control-arbitration.zh.md)。见[持久 Browser Profile Agent Note](2026-08-19-persistent-browser-profiles.zh.md)与[进程内 Electron Browser Runtime Agent Note](2026-08-19-electron-browser-runtime.zh.md)。

## 验证

- `pnpm vitest run packages/browser/browser-runtime-tandem` —— 基于仓库内 Tandem HTTP fixture 的生命周期、健康检查、崩溃/重连投影、协议拒绝与释放测试。
- `pnpm run test:coverage packages/browser/browser-runtime-tandem` —— 针对该包源码的逐文件覆盖率门。
- `pnpm run test:snapshot -t tandem` —— `browser-runtime-tandem` headless 快照场景（针对本地 Tandem HTTP fixture 执行 tool_search → browser_create → browser_navigate → browser_observe → browser_screenshot → browser_focus → browser_close）。
- 真实 Tandem.app e2e 仍会跳过；生产环境从不启动该二进制。Electron 门控 e2e 位于 `dsh-browser-runtime-electron`。
