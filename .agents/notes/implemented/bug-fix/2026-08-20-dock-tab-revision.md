# Agent Note: Dock mutations use the addressed tab revision

Status: implemented

English | [中文](2026-08-20-dock-tab-revision.zh.md)

## Problem

Browser Runtime mutations require `expectedRevision` of the addressed tab and reject a mismatch with `BROWSER_REVISION_CONFLICT`. The Dock and collapsed preview observed only the active tab, then sent that page's revision with `focus` and `close` for every chip. Independent navigations diverge per-tab revisions, so a background-tab gesture almost always conflicts.

## Decision

`BrowserWorkspaceTabRecord` carries the last Runtime revision the Binder committed for that tab. `create`, `navigate`, `focus`, `input`, `takeover`, `returnControl`, `observe` of a non-closed tab, and `browser/runtime-state` for an owned unclosed tab persist that revision on the `browser/workspace` snapshot. `observe` of a closed tab forgets the row. The Dock and preview send the addressed listing row's `revision` with `focus` and `close`. Conversation selection of a `browser_*` tool row sends the same listed revision ([chat browser-tool focus](../feature/2026-08-20-chat-browser-tool-focus-dock.md)). They do not observe every tab. Refresh, takeover, and return-to-Agent still use the observed page revision, which is the current revision of the active tab those verbs address. Refresh observes immediately before navigate so it does not reuse a stale `about:blank` URL from an earlier observe of the same tab.

The listing is Session state, not a new model-visible input. Logged Workspace snapshots still do not enter derived model history. The `browserWorkspace` projection uses `stateVersion` 2 so a cached row without per-tab revision is discarded.

This extends the Session-owned listing in the [Session-owned Browser Workspace Agent Note](../feature/2026-08-19-session-browser-workspace.md) and the Dock chrome in the [Native Browser Dock Agent Note](../feature/2026-08-19-browser-dock.md). Runtime-internal bumps and observe-of-closed forgetting are owned by the [Dock listing stale Agent Note](2026-08-20-dock-listing-stale.md). The revision lock itself stays in the [browser control arbitration Agent Note](../feature/2026-08-19-browser-control-arbitration.md).

## Alternatives considered

**Observe every tab from the Dock.** Rejected because the Workspace listing already addresses every tab the chrome can click, and N observe RPCs would not restore a revision after Session switch.

**Observe the clicked tab, then mutate.** Rejected because the click still needs an authoritative revision after reload, and the Binder already sees that revision on every mutation. A second observe is an extra RPC that duplicates the listing.

**Keep revision only in Dock React state.** Rejected because Session switch and reload must restore the same `expectedRevision`; Dock memory is not a Session fact.

## Consequences

A revision-advancing mutation writes `browser/workspace`. The keyless fixture Session still has one tab, so the assembled snapshot cannot exercise two-tab focus or close.

## Testing

`packages/browser/browser-workspace/tests/workspace.spec.ts` pins listed revisions on a two-tab focus and close. `packages/client/ui-browser/tests/model.client.spec.ts` and `browser-preview.client.spec.tsx` assert the addressed listing revision. The [Dock navigate chrome Agent Note](2026-08-20-dock-navigate-chrome.md) owns re-observing the active tab when that listed revision advances. `apps/web/tests/browser-dock.snapshot.ts` pins the restored preview and the expanded Dock chrome after open and Refresh. The headless `browser-runtime` and `browser-runtime-tandem` stream-json snapshots now carry per-tab revision on every `browser/workspace` event.
