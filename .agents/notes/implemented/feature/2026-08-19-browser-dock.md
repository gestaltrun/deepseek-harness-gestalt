# Agent Note: Native Browser Dock

Status: implemented

English | [中文](2026-08-19-browser-dock.zh.md)

## Problem

A Session can own Browser Workspaces, instances, tabs, Dock geometry, and the current control owner, but the Session Surface still had no native pane for those facts. Embedding another Electron BrowserView would split ownership with the Desktop Host. A second Dock in conversation history would duplicate the same occupant.

## Decision

`dsh-client-ui-browser` presents the Session-owned Browser Workspace as official screenshot-plus-text chrome. Occupancy later moved into the workbench sidebar `browser` tab; see the [workbench official browser Agent Note](2026-08-21-workbench-official-browser.md). The collapsed preview still occupies `conversation.browser.preview`. Live facts arrive through `useProjection('browserWorkspace')`. Mutations go through the generated `remote.browserWorkspace` namespace, including `create`.

The chrome has no Profile switch or Agent-status row. The workbench sidebar tab bar is the page list; page chrome has no tab strip. Persistent Profile names appear only next to the address field. The active tab's label, address, and screenshot re-observe when that tab's listed revision advances, so a Binder-committed navigate replaces still-blank `about:blank` chrome. Refresh observes the Runtime's current URL, then navigates to it. The address field is editable: Enter navigates, and a host without a scheme receives `https://`. The viewport shows the latest screenshot and page text and scrolls when the screenshot is larger than the pane; it does not embed a second process. Official chrome does not occupy `details`; the narrow overlay stays for other details occupants ([narrow overlay Agent Note](../bug-fix/2026-08-21-narrow-browser-dock-overlay.md)).

A collapsed preview is a one-line layered summary of the same pages. Clicking a back layer focuses that tab with its listed revision; clicking the current layer reveals the workbench tab through better-sidebar. A listed-revision conflict on a background chip observes once and retries, or shows the failure; that recovery is owned by the [listing stale Agent Note](../bug-fix/2026-08-20-dock-listing-stale.md). ChatView hides the preview when the conversation right gutter is narrower than 240px. Ordinary MCP tool rows stay in conversation history. Selecting a `browser_*` tool row focuses the listed tab; the [chat browser-tool focus Agent Note](2026-08-20-chat-browser-tool-focus-dock.md) owns that path. The [reported control and Dock-state removal](../simplification/2026-08-22-remove-reported-browser-control-and-dock-state.md) owns presentation-state authority.

The 420/640/960 px details range from [#60](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/60) remains exported and unused while official chrome lives in the workbench. Session switch restores per-Session visibility, width, instances, tabs, current control owner, and each tab's last committed revision from the Workspace projection owned by [#67](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/67). Focus and close send the addressed tab's listed revision; the [Dock tab revision Agent Note](../bug-fix/2026-08-20-dock-tab-revision.md) owns that contract.

Web and headless compositions mount `dsh-browser-runtime-deterministic` plus `dsh-browser-workspace` so the Dock has a Session-owned Runtime without Electron. The Host composition also inserts `dsh-tool-browser`; Web composition disables that host-plane row so the standard, code, and cordis presets remount it, matching `tool-web`, and mounts the Dock plugin. Desktop Host owns in-process Electron `webContents` and the overlay HTTP client; the Dock still renders screenshot, title, and text and does not embed a second BrowserView.

DetailsPanel (`id: 'tool'`) renders nothing when the chat store has no selection, so the details list stays empty unless a tool call is selected. ChatView always requests `conversation.browser.preview` and hides that rail when the right gutter cannot host it. The page viewport rebinds the elevated scrollbar pair because it paints `--dsw-alias-bg-module-platform` and the page-text overlay scrolls inside it.

## Alternatives considered

**Embed a Desktop-owned Electron BrowserView.** Rejected because DeepSeek Gestalt must own the Dock occupant; a second process would split page identity from the Session Workspace.

**Keep a second live card in conversation while the Dock is open.** Rejected because the preview is a reopen path for the same Dock, not a second Dock.

**Store Dock open and width only in the layout store.** Rejected because each Session must restore those facts after switch and reload.

## Consequences

Human and Agent share one Dock over the same Session-owned tab identities. Collapse is a Session fact, so later Agent activity cannot steal the pane open. Web and Desktop render the same occupant; neither embeds a second BrowserView. Release remains a later ticket.

## Verification

- `pnpm exec vitest run packages/client/ui-workbench packages/client/ui-browser packages/browser/browser-workspace packages/client/ui-conversation/tests/preview-rail.client.spec.ts packages/client/ui-conversation/tests/chat-view.client.spec.tsx`
- `pnpm exec vitest run packages/client/ui-browser --coverage --coverage.include='packages/client/ui-browser/src/**/*.ts'`
- `pnpm run check:ci:static`
