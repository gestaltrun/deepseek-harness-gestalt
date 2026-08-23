# Browser Runtime

English | [中文](browser-runtime.zh.md)

The Browser Runtime capability separates the provider-neutral [`ctx.browserRuntime`](../../packages/browser/browser-runtime) service, the keyless [`dsh-browser-runtime-deterministic`](../../packages/browser/browser-runtime-deterministic) Provider, the in-process Electron [`dsh-browser-runtime-electron`](../../packages/browser/browser-runtime-electron) Provider, the Tandem-shaped HTTP [`dsh-browser-runtime-tandem`](../../packages/browser/browser-runtime-tandem) client, the Session-owned [`dsh-browser-workspace`](../../packages/browser/browser-workspace) binder, and the deferred [`dsh-tool-browser`](../../packages/browser/tool-browser) Consumer. It is an optional capability outside the Agent loop.

## Identity and state

A `BrowserTarget` contains four opaque branded identities: Profile, Workspace, browser instance, and tab. Callers carry the complete target returned by `create`; none of its string values have caller-visible structure. Open state contains URL, title, text, focus, revision, address-field `chrome`, and `storage`. Storage isolation is the Chromium partition named on `chrome.partition`; storage fields stay empty unless a Provider observed them. Temporary chrome omits a label. Shared chrome names the reserved installation-wide identity and must not claim isolation. Closed state is a terminal receipt retaining the target and revision.

An `unavailable` state is the truthful projection of Provider availability loss for an existing target: the Electron Provider commits it when a renderer process crashes, and the Tandem-shaped HTTP client commits it when its loopback server or optional fixture child fails health checks. Both keep the target and last revision, name the loss reason, and flag an in-flight reconnect. It is not the terminal closed receipt; a successful reconnect re-commits open page state for the same target at the next revision, and exhausted reconnects commit `reconnect-failed`.

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

## Concurrency and lifecycle

Providers serialize operations. `create` may attach a new instance to an existing Workspace or a new tab to an existing instance. `navigate`, `focus`, synthetic Agent `input`, and `close` require the last observed revision and reject stale mutations. The revision is optimistic concurrency control across tools, Workbench chrome, Provider recovery, and cleanup; `observe` and `screenshot` do not advance it. A named persistent Profile restores the same `persist:session-*` partition after close. A shared Profile restores `persist:session-*-shared` and does not take `BROWSER_PROFILE_BUSY`. Temporary Profiles receive ephemeral `session-*` partitions and leave no reusable identity. A second independent writer of the same named Profile rejects with `BROWSER_PROFILE_BUSY`. Teardown stops new admission, drains accepted operations, and closes every open Profile. Session-local instance ownership, Profile-matched reuse, per-tab revision projection, and cross-Session isolation live in [`dsh-browser-workspace`](../../packages/browser/browser-workspace).

The deterministic Provider gives each generation an independent owner token. Its invariant seeds from that generation's authoritative current state on initial load and hot reload, then registers a synchronous pre-commit validator for stable identity, exact revision succession, and terminal closure. A validation failure leaves the previous state authoritative. After commit, the Provider publishes on `browser/runtime-state`; each ordinary observer failure is contained, later observers still run, and asynchronous observers are not awaited.

The Electron Provider owns frameless page `webContents` in this process. It loads only when `process.versions.electron` is set, creates `persist:session-*` partitions for named and shared Profiles and ephemeral `session-*` partitions for temporary Profiles, captures PNG bytes with `webContents.capturePage`, reads page text with `executeJavaScript`, and delivers synthetic Agent text through one insert-or-key path. Chromium persist partitions live at Electron `userData/Partitions/<name>`. A renderer crash commits `unavailable` and recreates the hidden window for the same target. A `loadURL` that rejects `ERR_ABORTED` after a redirect, or a Chromium net error after Chromium painted its error document, commits as an open page and keeps the requested URL when Chromium reports `chrome-error:`. Desktop Host presents the same page as a `WebContentsView` on the Host `contentView`, paints Settings and the sidebar `+` menu in a second transparent overlay `WebContentsView` stacked above that page, and also binds Tandem's HTTP vocabulary over that engine so the Node Web Host can drive it.

The tandem package is a protocol-only HTTP client for that vocabulary at pinned revision `3b613cfd4c299609ca7ca415d638c1b71c6ba5de`. It constrains `baseUrl` to an absolute loopback HTTP origin, reads the bearer token from `tokenFile`, and polls `GET /agent/version` and `GET /status` under `startupTimeoutMs` before admitting work. Each Profile creates one HTTP session (`POST /sessions/create`) on a `persist:session-*` or ephemeral `session-*` partition, projecting DSH-owned opaque identities around tab ids. Synthetic Agent `input` uses `POST /input` with the client's `expectedRevision`. Production Desktop never launches Tandem.app; an optional fixture child exists only for HTTP protocol tests, and `sidecar: false` rejects `command`/`cwd` at plugin load. Malformed responses reject with `BROWSER_PROTOCOL`; a lost or unreachable runtime rejects with `BROWSER_RUNTIME_UNAVAILABLE`. Provenance and upstream-contribution candidates live in the package's [UPSTREAM.md](../../packages/browser/browser-runtime-tandem/UPSTREAM.md).

## Discovery and replay

The Consumer registers seven deferred ordinary tools. `tool_search` returns schemas without activating tools, and current eligibility remains authoritative. Every operation renders complete Browser page facts into the durable ordinary tool result. When a calling Agent Session is present and the Workspace binder is composed, created tabs also become Session-owned Workspace facts. Together with logged request headers and `browser/workspace` snapshots, the Session can reconstruct model-visible Browser facts and Session-local Workspace ownership.

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
