# Agent Note: Remove reported Browser control and Workspace Dock state

Status: implemented

English | [中文](2026-08-22-remove-reported-browser-control-and-dock-state.zh.md)

## Problem

The Browser Runtime reported an `agent` or `human` control owner and exposed `takeover` and `returnControl`, but the live `WebContentsView` had no pointer or keyboard event bridge that produced those facts. Direct page interaction already worked independently, so the reported owner described an unimplemented arbitration product while every Provider, Workspace snapshot, Remote, tool, fixture, and document carried it. Browser Workspace also persisted `dockOpen`, `dockWidth`, and `userCollapsed` even though better-sidebar already owned per-Session panel visibility and width.

The revision counter served a different purpose. Tools, Workbench chrome, Provider recovery, and cleanup can mutate one tab concurrently, so removing reported control does not remove the need to reject stale writes.

## Decision

Browser page and unavailable state carry no control owner. Browser Runtime, Browser Workspace, generated Remotes, and `dsh-tool-browser` expose no takeover or return-control operation. `browser_input` remains as synthetic Agent input, requires a non-empty URL or text value, and advances the tab revision. A directly presented Electron page remains interactable by the person without projecting that interaction as Runtime ownership.

Revision is the only concurrency mechanism. `navigate`, `focus`, `input`, and `close` require `expectedRevision`; Providers serialize accepted operations and reject stale writes with `BROWSER_REVISION_CONFLICT`. Workspace snapshots retain each tab's latest revision and use state version `3` to reject the removed payload fields.

Browser Workspace projections contain only the owned Workspace hierarchy, active identities, and per-tab revisions. Better-sidebar owns workbench panel visibility and width. The collapsed preview reveals the current sidebar tab without writing Browser state.

Browser Workspace also owns implicit matching-Profile reuse. Creates without `attach` serialize per Binder and reuse an open browser instance for the Session's shared Profile or the same named persistent Profile; temporary Profiles remain independent. Workbench passes the unresolved create request and does not infer attach from UI metadata.

The client composition imports `BrowserPageChrome` through an explicit `ui-browser/client` module-table request, consumes the Workspace package's inline-safe page flattener, shares the API Remote result unwrap, and consumes the Browser settings resolver owned by `ui-browser`. `OfficialBrowserTab` renders page chrome and delegates empty-tab creation to `OfficialBrowserBridge`; it has no direct-create recovery path.

This decision supersedes the reported-ownership part of [browser control arbitration](../feature/2026-08-19-browser-control-arbitration.md), the Workspace Dock fields in [Session Browser Workspace](../feature/2026-08-19-session-browser-workspace.md), and the Dock-following rules in [workbench official Browser](../feature/2026-08-21-workbench-official-browser.md). Their revision, Session isolation, page chrome, overlay, and stale-listing decisions remain current.

## Alternatives considered

**Connect real page events to reported ownership.** Rejected because direct `WebContentsView` interaction needs no ownership state, and event attribution would add a second lifecycle across Chromium input, Runtime state, durable projection, tools, and UI without changing who can interact.

**Remove revision with control ownership.** Rejected because stale Agent or Workbench writes would become silent last-writer-wins, and Provider crash or reconnect commits would race mutations without a common version.

**Keep Dock fields as aliases of better-sidebar state.** Rejected because two persisted authorities can disagree during Session switch and reload. Presentation state has one owner in better-sidebar.

**Keep Client-side attach inference.** Rejected because the Workspace Binder serializes creates and owns the authoritative open Profile hierarchy. UI metadata can be absent or stale and cannot safely choose Runtime instance reuse.

## Consequences

The Browser tool set contains seven operations instead of nine, Workspace payload version `3` is intentionally incompatible with the removed state, and code that relied on takeover, return control, or Dock Remotes must use page revisions and better-sidebar presentation state. Human interaction remains available on the live Desktop page but is not observable as a Browser Runtime fact.

The removal deletes a cross-package state dimension and duplicate Client helpers while preserving multi-instance identity, Profile isolation, collapsed previews, direct page interaction, and optimistic concurrency. The pinned sidebar emits declarations only for its own snapshot sources, so a Host build cannot write dependency declarations beside repository sources. Runtime, Workspace, Tool, connection fixture, Workbench, overlay, generated catalog, and client aggregate tests pin the remaining behavior.
