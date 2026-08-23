# Agent Note: Official Browser in the workbench sidebar

Status: implemented

English | [中文](2026-08-21-workbench-official-browser.zh.md)

## Problem

The first workbench snapshot mount turned off the snapshot iframe browser and left official Session browsing in the `details` Dock. That put official chrome on the wrong pane: the workbench overlay already owns the right side, and the collapsed preview sat under the message column instead of in the unused strip to the right of chat. User `+ → Browser` also could not create a page because Client `remote.browserWorkspace` had no `create`.

## Decision

Official page chrome lives in the snapshot sidebar tab type `browser`. Each official Workspace page is one sidebar tab. The sidebar tab bar is the page list. The address field is editable and navigates on Enter; the refresh control is `aria-busy` while observe or navigate is in flight. Desktop Host presents the same Runtime `webContents` as a `WebContentsView` on the Host `contentView` so the user can click, type, and scroll. Settings and the sidebar `+` menu are the same React components as `dsh web`; under Electron they mount in a second transparent `WebContentsView` stacked above official pages, and `dsh web` keeps the in-document panel and menu. The overlay document does not reconcile official pages or present/conceal live views. An unpresented page remains attached to a transparent, off-screen, non-focusable `BaseWindow`, which keeps Chromium painting for screenshots; presentation reparents only the `WebContentsView` to the Host, and conceal returns it to that paint host. `loadURL` that rejects `ERR_ABORTED` after a redirect, or a Chromium net error after Chromium painted its error document, is a committed navigation, not a crash. A child `BrowserWindow` plus `setParentWindow` is not used because that path SIGSEGVs on macOS Electron 41. `dsh web` paints screenshot-plus-text; `about:blank` captures stay hidden so a new tab shows start copy. `+ → Browser` and `browser_create` each create one official page using the `ui-browser` default identity. Browser Workspace serializes creates and reuses an already-open Session instance only when its Profile matches that identity. An empty `+` tab calls `ensureOfficial`; `OfficialBrowserTab` has no direct-create fallback. One page retains one Session-bound Remote verb set for its `ctx` and Session id, so sidebar rerenders do not restart observe and screenshot. Closing a sidebar tab closes that official page.

Official Browser chrome does not occupy `details`. Better-sidebar owns panel visibility and width for each Session; Browser Workspace stores no presentation state.

The collapsed preview stays on `conversation.browser.preview`. ChatView paints it in the right gutter of the conversation scrollport, beside the centered message column, and hides the rail when that gutter is narrower than 240px. Clicking the current layer calls `workbenchBrowser.reveal`.

Host `browserWorkspace.create` is now `@Remote('create')`. Browser Workspace's client outlet owns Remote-result unwrapping, so UI packages do not evaluate the complete Remote assembly to consume that pure adapter. The settings page still does not create tabs. Snapshot `BrowserView` stays on disk: when `ctx.workbenchBrowser` is published it renders official chrome; otherwise the iframe remains the standalone fallback. `betterSidebar.setPanelOpen` expands the panel without minting a dummy URL.

## Alternatives considered

**Keep official chrome in `details` and the workbench beside it.** Rejected because both paint on the right and the user asked to leave Dock.

**Replace snapshot `BrowserView` with a live iframe talking to official Runtime.** Rejected because sites such as Baidu refuse embedding; Desktop presents the existing Runtime `webContents` instead of a second document.

**Child `BrowserWindow` over the sidebar viewport.** Rejected because `setParentWindow` SIGSEGV on macOS Electron 41.

**Raise the Host chrome `WebContentsView` and punch holes through HTML.** Rejected because HTML `z-index` cannot cover a sibling page view, and making Host chrome see-through blacks out the session while the menu or settings dialog still sits under the page.

**Delete snapshot `BrowserView`.** Rejected because every `git subtree pull` would reintroduce the file.

## Consequences

One product browser. ChatView hides the preview when the right gutter cannot host it. Narrow-window details overlay is not required for Browser chrome. The [Browser control and Dock-state removal](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md) owns presentation and create-reuse authority.

## Verification

- `pnpm exec vitest run packages/client/ui-workbench packages/client/ui-browser packages/browser/browser-runtime-electron packages/client/ui-conversation/tests/preview-rail.client.spec.ts packages/client/ui-conversation/tests/chat-view.client.spec.tsx packages/browser/browser-workspace/tests/workspace.spec.ts apps/desktop/tests/browser-present.spec.ts apps/desktop/tests/chrome-overlay.spec.ts packages/client/ui-desktop/tests/desktop-chrome-overlay.client.spec.tsx packages/client/ui-layout/tests/app-frame.client.spec.tsx packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`
- `pnpm run test:electron-runtime-e2e` proves hidden-page screenshots and Profile isolation in a real Electron process.
- `DSH_COVERAGE_PARTITIONS=4 pnpm run check:ci:coverage` covers every changed Browser and workbench branch.
- `apps/web/tests/browser-dock.snapshot.ts` pins the collapsed preview and workbench page chrome after open and Refresh
- `pnpm run check:ci:consumers` runs the Web gate after every built-client artifact reader. The serial HMR owner restores the complete build-record artifact set before the parallel Web pool consumes it.
