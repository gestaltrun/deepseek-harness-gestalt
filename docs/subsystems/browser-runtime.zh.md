# 浏览器运行时

[English](browser-runtime.md) | 中文

Browser Runtime 能力把与 Provider 无关的 [`ctx.browserRuntime`](../../packages/browser/browser-runtime) 服务、无密钥 [`dsh-browser-runtime-deterministic`](../../packages/browser/browser-runtime-deterministic) Provider、进程内 Electron 的 [`dsh-browser-runtime-electron`](../../packages/browser/browser-runtime-electron) Provider、Tandem 形态 HTTP 的 [`dsh-browser-runtime-tandem`](../../packages/browser/browser-runtime-tandem) 客户端、Session 持有的 [`dsh-browser-workspace`](../../packages/browser/browser-workspace) binder 与延迟 [`dsh-tool-browser`](../../packages/browser/tool-browser) Consumer 分离开来。它是 Agent loop 之外的可选能力。

## 身份与状态

`BrowserTarget` 包含四个不透明品牌身份：Profile、Workspace、浏览器实例与标签页。调用方携带 `create` 返回的完整 target；这些字符串值没有调用方可见结构。打开状态包含 URL、标题、文本、焦点、修订号、地址栏 `chrome` 与 `storage`。存储隔离来自 `chrome.partition` 上的 Chromium partition；除非 Provider 观察到这些字段，否则它们保持为空。临时 chrome 不带标签。共享 chrome 使用保留的安装范围身份名，且不得声称隔离。关闭状态是保留 target 与修订号的终态回执。

`unavailable` 状态是对既有 target 的 Provider 可用性丢失的真实投影：Electron Provider 在渲染进程崩溃时提交它，Tandem 形态 HTTP 客户端在其 loopback 服务器或可选 fixture 子进程健康检查失败时提交它。两者都保留 target 与最后修订号，说明丢失原因，并标记进行中的重连。它不是终态关闭回执；重连成功后会以同一 target、下一修订号重新提交打开页面状态，重连耗尽则提交 `reconnect-failed`。

```ts type-equiv
/** Address-field chrome. Temporary Profiles omit a label. Shared chrome names the shared identity and must not claim isolation. */
interface BrowserProfileChrome {
  readonly kind: BrowserProfileKind
  readonly name?: BrowserProfileName
  readonly partition: string
}
```

```ts type-equiv
/** Recoverable or terminal Provider availability loss for an existing target. */
interface BrowserUnavailableState {
  readonly status: 'unavailable'
  readonly target: BrowserTarget
  readonly revision: number
  readonly reason: 'crashed' | 'unhealthy' | 'reconnect-failed'
  readonly reconnecting: boolean
}
```

## 并发与生命周期

Provider 串行执行操作。`create` 可以把新实例附加到已有 Workspace，或把新标签页附加到已有实例。`navigate`、`focus`、Agent 合成 `input` 与 `close` 要求最后观察到的修订号，并拒绝过期写入。修订号为工具、Workbench chrome、Provider 恢复与清理提供乐观并发控制；`observe` 与 `screenshot` 不递增修订号。命名持久 Profile 在关闭后恢复同一 `persist:session-*` partition。共享 Profile 恢复 `persist:session-*-shared`，且不占用 `BROWSER_PROFILE_BUSY`。临时 Profile 获得临时 `session-*` partition，且不留下可复用身份。同一命名 Profile 的第二个独立写入方会以 `BROWSER_PROFILE_BUSY` 拒绝。释放阶段停止接收新操作、排空已接受操作，并关闭每个仍打开的 Profile。Session 本地实例所有权、Profile 匹配复用、每标签页修订号投影与跨 Session 隔离见 [`dsh-browser-workspace`](../../packages/browser/browser-workspace)。

确定性 Provider 为每个 generation 分配独立 owner token。其 invariant 在首次加载与热重载时从该 generation 的当前权威 state 建立基线，随后为稳定身份、精确修订顺序与终态关闭注册同步 pre-commit validator。验证失败时，原 state 仍是权威来源。提交后，Provider 在 `browser/runtime-state` 上发布状态；每个普通 observer failure 都受到容纳，后续 observer 继续运行，且异步 observer 不会被等待。

Electron Provider 在本进程中持有无框页面 `webContents`。它仅在 `process.versions.electron` 已设置时加载，为命名与共享 Profile 创建 `persist:session-*` partition、为临时 Profile 创建临时 `session-*` partition，用 `webContents.capturePage` 捕获 PNG 字节，用 `executeJavaScript` 读取页面文本，并通过单一插入或按键路径送达 Agent 合成文本。Chromium persist partition 位于 Electron `userData/Partitions/<name>`。渲染进程崩溃会提交 `unavailable`，并为同一 target 重建隐藏窗口。`loadURL` 在重定向后拒绝 `ERR_ABORTED`，或在 Chromium 已画出错误文档后拒绝网络错误，会作为打开页面提交；Chromium 报告 `chrome-error:` 时仍保留请求的 URL。Desktop Host 把同一页面作为 `WebContentsView` 加到 Host `contentView` 上，设置弹层和侧栏 `+` 菜单画在第二块透明 overlay `WebContentsView` 上并叠在该页面之上，还会在该引擎上绑定 Tandem 的 HTTP 词汇，使 Node Web Host 可以驱动它。

tandem 包是该词汇在固定 revision `3b613cfd4c299609ca7ca415d638c1b71c6ba5de` 上的协议专用 HTTP 客户端。它把 `baseUrl` 约束为绝对的 loopback HTTP origin，从 `tokenFile` 读取 bearer token，并在接收任何操作之前于 `startupTimeoutMs` 内轮询 `GET /agent/version` 与 `GET /status`。每个 Profile 在 `persist:session-*` 或临时 `session-*` partition 上创建一个 HTTP session（`POST /sessions/create`），把 DSH 持有的不透明身份投影到 tab id 之上。Agent 合成 `input` 使用携带客户端 `expectedRevision` 的 `POST /input`。生产环境的 Desktop 从不启动 Tandem.app；可选 fixture 子进程仅用于 HTTP 协议测试，且 `sidecar: false` 在插件加载拒绝 `command`/`cwd`。格式错误的响应以 `BROWSER_PROTOCOL` 拒绝；丢失或不可达的运行时以 `BROWSER_RUNTIME_UNAVAILABLE` 拒绝。出处与上游贡献候选见包内 [UPSTREAM.md](../../packages/browser/browser-runtime-tandem/UPSTREAM.md)。

## 发现与重放

Consumer 注册七个延迟普通工具。`tool_search` 返回 schema 但不激活工具，当前 eligibility 继续作为权威。每次操作把完整 Browser 页面事实渲染到持久普通工具结果中。当调用 Agent Session 存在且已组合 Workspace binder 时，创建的标签页也会成为 Session 持有的 Workspace 事实。结合已记录的请求头与 `browser/workspace` 快照，Session 可以重建模型可见的 Browser 事实以及 Session 本地 Workspace 所有权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowserruntime--browserruntime-abstract-seam"></a>

### `ctx.browserRuntime` — `BrowserRuntime` (abstract seam)

Browser Runtime Service Definition. Providers serialize every operation, own target lifecycles, and reject stale mutations. Callers retain returned targets and revisions but do not dispose Provider resources directly. A method resolves only after its state commit and synchronous post-commit notification attempts; asynchronous observers are not awaited.

```ts cordis-catalog
/**
 * Create one temporary, named persistent, or shared Profile tab. Omitting `attach` starts a new
 * Workspace and browser instance. Attaching to a Workspace starts another instance; attaching to a
 * browser instance starts another tab in that instance.
 * @param request - Temporary, named persistent, or shared Profile request, optional attach, and
 * cancellation.
 * @returns initial open page state at revision zero; its target addresses every later operation in
 * this lifecycle. Persistent and shared Profiles restore the same storage partition on later
 * creates. Shared creates from different Sessions reuse one partition and do not take
 * `BROWSER_PROFILE_BUSY`.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED` when cancellation wins, `BROWSER_DISPOSED`
 * after teardown starts, `BROWSER_NOT_FOUND` when `attach` names a missing hierarchy,
 * `BROWSER_PROFILE_BUSY` when the named persistent Profile already has a writer,
 * `BROWSER_PROFILE_NAME` when the name cannot be a stable partition key, `BROWSER_PROTOCOL` when
 * the upstream runtime breaks its response protocol, or `BROWSER_RUNTIME_UNAVAILABLE` when the
 * upstream runtime cannot be reached or starts unhealthy.
 */
abstract create(request: BrowserCreateRequest): Promise<BrowserPageState>

/**
 * Navigate the addressed tab after checking its expected revision.
 * @param request - Target, expected revision, URL, and cancellation signal.
 * @returns committed open page state whose revision replaces the caller's prior revision.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
 * `BROWSER_NOT_OPEN`, `BROWSER_REVISION_CONFLICT`, or `BROWSER_UNKNOWN_URL` when the corresponding
 * precondition fails before commit, `BROWSER_PROTOCOL` when the upstream runtime breaks its
 * response protocol, or `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
 */
abstract navigate(request: BrowserNavigateRequest): Promise<BrowserPageState>

/**
 * Observe the latest open or closed state for one target.
 * @param request - Target and cancellation signal.
 * @returns current open, unavailable, or closed state after earlier queued operations. Read-only
 * observation does not advance the revision; an external Provider crash or reconnect may do so.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, or
 * `BROWSER_NOT_FOUND`; a closed target is returned rather than rejected, and an unavailable
 * upstream runtime is returned as its unavailable state. `BROWSER_PROTOCOL` is rejected when the
 * upstream runtime breaks its response protocol.
 */
abstract observe(request: BrowserObserveRequest): Promise<BrowserRuntimeState>

/**
 * Capture PNG bytes for the addressed open tab.
 * @param request - Target and cancellation signal.
 * @returns screenshot bytes and depicted page facts from one serialized read at the current revision.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
 * `BROWSER_NOT_OPEN`, or `BROWSER_UNKNOWN_URL` when the Provider cannot depict the addressed open
 * page, `BROWSER_PROTOCOL` when the upstream runtime breaks its response protocol, or
 * `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
 */
abstract screenshot(request: BrowserObserveRequest): Promise<BrowserScreenshot>

/**
 * Focus the addressed tab after checking its expected revision.
 * @param request - Target, expected revision, and cancellation signal.
 * @returns committed focused page state whose revision replaces the caller's prior revision.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
 * `BROWSER_NOT_OPEN`, or `BROWSER_REVISION_CONFLICT` when the corresponding precondition fails
 * before commit, `BROWSER_PROTOCOL` when the upstream runtime breaks its response protocol, or
 * `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
 */
abstract focus(request: BrowserMutationRequest): Promise<BrowserPageState>

/**
 * Apply synthetic Agent input after checking the expected revision.
 * @param request - Target, expected revision, URL or page text, and cancellation.
 * @returns committed open page whose revision replaces the caller's prior revision. Session,
 * Profile, browser instance, and tab identities stay the same.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
 * `BROWSER_NOT_OPEN`, `BROWSER_REVISION_CONFLICT`, or `BROWSER_UNKNOWN_URL` when the
 * corresponding precondition fails before commit, `BROWSER_PROTOCOL` when the upstream runtime
 * breaks its response protocol, or `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
 */
abstract input(request: BrowserInputRequest): Promise<BrowserPageState>

/**
 * Close the addressed tab after checking its expected revision. Temporary Profiles discard
 * identity; persistent Profiles keep the named storage partition.
 * @param request - Target, expected revision, and cancellation signal.
 * @returns terminal close receipt retained by the Provider for later observation.
 * @throws `BrowserRuntimeError` with `BROWSER_ABORTED`, `BROWSER_DISPOSED`, `BROWSER_NOT_FOUND`,
 * `BROWSER_NOT_OPEN`, or `BROWSER_REVISION_CONFLICT` when the corresponding precondition fails
 * before commit, `BROWSER_PROTOCOL` when the upstream runtime breaks its response protocol, or
 * `BROWSER_RUNTIME_UNAVAILABLE` when it cannot be reached.
 */
abstract close(request: BrowserMutationRequest): Promise<BrowserClosedState>
```

Source: [`packages/browser/browser-runtime/src/index.ts:108`](../../packages/browser/browser-runtime/src/index.ts)

<a id="ctxbrowserworkspace--browserworkspacebinder"></a>

### `ctx.browserWorkspace` — `BrowserWorkspaceBinder`

Bind Browser Runtime identities to one Session log and project instance and tab ownership from durable Session facts.

```ts cordis-catalog
/**
 * Read the last logged Workspace for one Session.
 * @param session - Owning Session.
 * @returns the last logged snapshot, or the empty Workspace.
 */
snapshot(session: Session): BrowserWorkspaceProjection

/**
 * Observe one Session-owned tab named on the wire.
 * @param sessionId - Owning Session identity.
 * @param target - Complete tab identity.
 * @returns the current open, unavailable, or closed state. A closed result
 *   forgets the listing row.
 */
@Remote('observe') remoteObserve(sessionId: SessionId, target: BrowserTarget): Promise<BrowserRuntimeState>

/**
 * Capture one Session-owned tab named on the wire.
 * @param sessionId - Owning Session identity.
 * @param target - Complete tab identity.
 * @returns screenshot bytes and depicted page facts.
 */
@Remote('screenshot') remoteScreenshot(sessionId: SessionId, target: BrowserTarget): Promise<BrowserScreenshot>

/**
 * Focus one Session-owned tab named on the wire.
 * @param sessionId - Owning Session identity.
 * @param target - Complete tab identity.
 * @param expectedRevision - Latest revision returned by a browser operation.
 * @returns the committed focused page.
 */
@Remote('focus') remoteFocus(sessionId: SessionId, target: BrowserTarget, expectedRevision: number): Promise<BrowserPageState>

/**
 * Navigate one Session-owned tab named on the wire.
 * @param sessionId - Owning Session identity.
 * @param target - Complete tab identity.
 * @param expectedRevision - Latest revision returned by a browser operation.
 * @param url - URL to open.
 * @returns the committed open page.
 */
@Remote('navigate') remoteNavigate( sessionId: SessionId, target: BrowserTarget, expectedRevision: number, url: string, ): Promise<BrowserPageState>

/**
 * Send one Agent-specified synthetic input to a Session-owned tab named on the wire.
 * @param sessionId - Owning Session identity.
 * @param target - Complete tab identity.
 * @param expectedRevision - Latest revision returned by a browser operation.
 * @param input - URL or text supplied by the Agent.
 * @returns the committed open page.
 */
@Remote('input') remoteInput( sessionId: SessionId, target: BrowserTarget, expectedRevision: number, input: { readonly url?: string; readonly text?: string }, ): Promise<BrowserPageState>

/**
 * Close one Session-owned tab named on the wire.
 * @param sessionId - Owning Session identity.
 * @param target - Complete tab identity.
 * @param expectedRevision - Latest revision returned by a browser operation.
 * @returns the terminal close receipt.
 */
@Remote('close') remoteClose(sessionId: SessionId, target: BrowserTarget, expectedRevision: number): Promise<BrowserClosedState>

/**
 * Create one tab in the Session named on the wire.
 * @param sessionId - Owning Session identity.
 * @param request - Wire create identity and optional attach.
 * @returns the committed open page.
 */
@Remote('create') remoteCreate(sessionId: SessionId, request: BrowserWorkspaceCreateRemoteRequest): Promise<BrowserPageState>

/**
 * Create one tab in the Session's Browser Workspace.
 * @param request - Session-bound create request.
 * @returns the committed open page.
 */
async create(request: BrowserWorkspaceCreateRequest): Promise<BrowserPageState>

/**
 * Navigate one Session-owned tab.
 * @param request - Session-bound navigate request.
 * @returns the committed open page.
 */
async navigate(request: BrowserWorkspaceNavigateRequest): Promise<BrowserPageState>

/**
 * Observe one Session-owned tab.
 * @param request - Session-bound observe request.
 * @returns the current open, unavailable, or closed state. A closed result
 *   forgets the listing row.
 */
async observe(request: BrowserWorkspaceObserveRequest): Promise<BrowserRuntimeState>

/**
 * Capture one Session-owned tab.
 * @param request - Session-bound observe request.
 * @returns screenshot bytes and depicted page facts.
 */
async screenshot(request: BrowserWorkspaceObserveRequest): Promise<BrowserScreenshot>

/**
 * Focus one Session-owned tab and record it as the Session's active tab.
 * @param request - Session-bound mutation request.
 * @returns the committed focused page.
 */
async focus(request: BrowserWorkspaceMutationRequest): Promise<BrowserPageState>

/**
 * Send one Agent-specified synthetic input to a Session-owned tab.
 * @param request - Session-bound input request.
 * @returns the committed open page.
 */
async input(request: BrowserWorkspaceInputRequest): Promise<BrowserPageState>

/**
 * Close one Session-owned tab and drop it from the Session Workspace.
 * @param request - Session-bound mutation request.
 * @returns the terminal close receipt.
 */
async close(request: BrowserWorkspaceMutationRequest): Promise<BrowserClosedState>

/**
 * Close every live tab still owned by one Session.
 * @param session - Session whose leftover Runtime tabs must be closed.
 */
async cleanup(session: Session): Promise<void>
```

Types: [Session](session.md) · [SessionId](core.md)

Source: [`packages/browser/browser-workspace/src/index.ts:101`](../../packages/browser/browser-workspace/src/index.ts)

<a id="browser-events"></a>

### `browser/*` events

<a id="browserruntime-state--emit"></a>

#### `browser/runtime-state` — emit

Post-commit Browser Runtime lifecycle notification. Providers contain synchronous throws and asynchronous rejections from each listener, continue the fan-out, and never change a committed operation's outcome; returned promises are observed but not awaited.

```ts cordis-catalog
/**
 * Post-commit Browser Runtime lifecycle notification. Providers contain synchronous throws and
 * asynchronous rejections from each listener, continue the fan-out, and never change a committed
 * operation's outcome; returned promises are observed but not awaited.
 * @mode emit
 * @param state - Complete committed state after the operation.
 */
'browser/runtime-state'(state: BrowserRuntimeState): void
```

Source: [`packages/browser/browser-runtime/src/index.ts:98`](../../packages/browser/browser-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
