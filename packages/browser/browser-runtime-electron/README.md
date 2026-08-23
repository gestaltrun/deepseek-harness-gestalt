# @deepseek-ai/dsh-browser-runtime-electron

English | [中文](README.zh.md)

In-process Electron Browser Runtime Provider for temporary, named persistent, and shared Profiles. It implements `ctx.browserRuntime` with this process's `session.fromPartition` and page `WebContentsView`s. Screenshots use `webContents.capturePage`; an initial Chromium `UnknownVizError` waits for one animation frame and retries once within the same operation deadline, while every other capture failure and a failed retry reject. Page text uses `executeJavaScript`. Named and shared Profiles restore `persist:session-*` partitions; temporary Profiles use ephemeral `session-*` partitions without the `persist:` prefix, so Chromium keeps their identity in memory and leaves nothing reusable on disk. Chromium persist partitions live at Electron `userData/Partitions/<name>` and never write `~/Library/Application Support/Tandem Browser`.

The plugin loads only when `process.versions.electron` is set or a Node test installs a host through `@deepseek-ai/dsh-browser-runtime-electron/testing`. Composing it on plain Node fails at load. Desktop Host presents the same `webContents` as a `WebContentsView` on the Host `contentView`. A child `BrowserWindow` is not used: `setParentWindow` on one SIGSEGV on macOS Electron 41.

## Configuration

| Field | Meaning | Default |
|---|---|---|
| `idPrefix` | Prefix for DSH-owned opaque Profile, Workspace, and browser identities | `electron` |
| `viewportWidth` | Hidden window width used for capture while the page is not presented | `1280` |
| `viewportHeight` | Hidden window height used for capture while the page is not presented | `800` |
| `requestTimeoutMs` | Bound on each Chromium navigation or content read | `30000` |

Durations and viewport sizes must be positive safe integers. Operations enter one serialized queue. Mutations require the caller's last observed `expectedRevision`. Synthetic Agent `input` uses one path: an insert script when an input, textarea, or contentEditable is focused; otherwise `char` input events. A newline is U+000A in a focused editable control; without one, each newline is a `char` event whose keyCode is `\\n`. The HTTP adapter rejects input without a non-empty URL or text. A second open writer of the same named Profile rejects with `BROWSER_PROFILE_BUSY`. Shared creates reuse the shared partition and do not take `BROWSER_PROFILE_BUSY`. After disposal starts, operations reject with `BROWSER_DISPOSED`. Disposal drains the queue and destroys remaining hidden windows.

A renderer-process crash commits `BrowserUnavailableState` with reason `crashed` and recreates the hidden window for the same target. Exhausted recovery commits `reason: 'reconnect-failed'`. Malformed Chromium results reject with `BROWSER_PROTOCOL`.

`listenElectronBrowserHttp` binds a loopback HTTP server that copies Tandem's session, tab, navigate, input, page-content, screenshot, focus, and destroy operations so the Web Host can drive this engine without embedding a second Electron application. Navigate, input, and focus compare the client's `expectedRevision` to the engine revision, reject a mismatch with 409 `BROWSER_REVISION_CONFLICT`, and return the engine's committed revision.

## Model Experience

Indirectly, through dsh-tool-browser, which renders every page, screenshot, lifecycle, and availability fact.

#### KV Cache effect

The Provider itself contributes no request text; Consumer schemas and logged results determine cache changes.

## Known Limitations and Deferred Work

- `present` places one open page over the Desktop Host window; `conceal` hides only that page without removing it from the Host `contentView`. `raisePresented` puts that page above Host chrome after the native overlay view hides. A `loadURL` that rejects `ERR_ABORTED` after a redirect, or a Chromium net error after Chromium painted its error document, is a committed navigation. Browser `dsh web` has no Host window and cannot present.
- Real Chromium e2e runs through `pnpm run test:electron-runtime-e2e`. Node `test:e2e` records the named skip; unit tests install a fake host via `@deepseek-ai/dsh-browser-runtime-electron/testing` and never spawn Tandem.app.
- Desktop Host ships this Provider on macOS and Windows. Linux is out of scope.
