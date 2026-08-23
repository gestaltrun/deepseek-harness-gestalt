# @deepseek-ai/dsh-client-ui-browser

English | [中文](README.zh.md)

Session-owned official Browser chrome and collapsed tab preview. [`dsh-client-ui-workbench`](../ui-workbench/README.md) imports the page chrome directly and mounts it inside the snapshot `browser` tab. This plugin occupies `conversation.browser.preview` and registers settings section `id: 'browser'`. Live Workspace facts arrive through `useProjection('browserWorkspace')`; mutations use the generated `remote.browserWorkspace` namespace and request the shared `api-remotes/client` helper from the module table.

The collapsed preview is a layered summary of the same official pages. ChatView paints it in the right gutter of the conversation scrollport and hides that rail when the gutter is narrower than 240px. Clicking a back layer focuses that tab with its listed revision; clicking the current layer reveals the workbench tab. A listed-revision `BROWSER_REVISION_CONFLICT` on a background chip observes that tab once and retries, or shows the failure. Ordinary MCP tool rows stay in conversation history.

Settings section `id: 'browser'` under namespace `ui-browser` holds a named persistent Profile roster and the default create identity (`shared` / `temporary` / `persistent`) that `browser_create` and sidebar `+ → Browser` use when the model or user omits `profile`. The page does not create Browser Workspaces.

The behavior is specified by the [workbench official browser Agent Note](../../../.agents/notes/implemented/feature/2026-08-21-workbench-official-browser.md) and the [Browser Dock Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-browser-dock.md).

## Model Experience

None, as this human-facing chrome adds no tools, messages, prompts, or provider requests; page operations stay on `dsh-tool-browser`.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Desktop presents the Runtime window; `dsh web` stays screenshot-plus-text** — `window.dshDesktop.browserPresent` places the same official `webContents` over the chrome viewport. Settings and the sidebar `+` menu mount in a native overlay view above that page; that overlay document does not present or conceal pages. The refresh control spins while observe or navigate is in flight. A committed Chromium net error keeps the error document in that live view. Browser `dsh web` has no Host window and still paints observe/screenshot facts.
- **Keyless web and headless Runtimes stay deterministic** — browser `dsh web` and headless keep `dsh-browser-runtime-deterministic`. Desktop Host owns in-process Electron `webContents` and points the overlay HTTP client at that loopback origin.
- **Profile settings do not create tabs** — the Browser section writes the roster and default identity only.
