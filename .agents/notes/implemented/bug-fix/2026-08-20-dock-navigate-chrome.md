# Agent Note: Dock chrome follows Binder-committed navigate

Status: implemented

English | [中文](2026-08-20-dock-navigate-chrome.zh.md)

## Problem

After a Desktop Host model round that created a temporary tab and navigated it to `https://example.com` (`status: open`, `revision: 1`), the Browser Dock stayed on the first `about:blank` observe: tab label, address field, and screenshot did not follow the Binder-committed page. The agent already reported the Example Domain heading from the tool result, so the Runtime mutation succeeded. Refresh reused that stale `about:blank` URL and revision and did not update the address field.

The Binder already writes the post-navigate revision through `recordFacts`. The listing does not store URL or title; Dock chrome reads those from `observe`. `useBrowserPage` only re-observed when tab identity changed, so the same tab kept the blank first observe. This is not the Runtime-internal crash-recovery listing gap in [#184](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/184).

## Decision

The Dock and collapsed preview pass the active tab's listed revision into `useBrowserPage`. When that revision advances, the hook observes and screenshots again and replaces chrome. A still-blank first tab (`about:blank`, listing revision `0`) stays blank until a successful navigate advances the listing. Refresh observes the Runtime page immediately, then navigates to that URL with that revision, so it does not reload a stale `about:blank` from React state.

This extends the chrome in the [Native Browser Dock Agent Note](../feature/2026-08-19-browser-dock.md) and the listed-revision contract in the [Dock tab revision Agent Note](2026-08-20-dock-tab-revision.md).

## Alternatives considered

**Put URL and title on `BrowserWorkspaceTabRecord`.** Rejected because the listing stays identity, control owner, and revision; page facts continue to come from observe and screenshot.

**Apply only Dock `refresh` / `navigate` RPC results into React state.** Rejected because Agent `browser_navigate` never goes through Dock verbs. The listing revision is the Session signal that those page facts changed.

**Subscribe the Dock to `browser/runtime-state`.** Rejected for this ticket because Binder-mediated navigate already commits the listing. Runtime-internal revision bumps without a Binder verb are owned by the [Dock listing stale Agent Note](2026-08-20-dock-listing-stale.md).

## Consequences

Active-tab chrome tracks Binder-committed pages after navigate and after Refresh. Background-tab listing after a Runtime-internal revision bump is owned by the [Dock listing stale Agent Note](2026-08-20-dock-listing-stale.md). Refresh adds one observe RPC before navigate.

## Testing

`packages/client/ui-browser/tests/browser-page-chrome.client.spec.tsx` and `use-browser-page.client.spec.tsx` fail when chrome stays `about:blank` after a `status: open` navigate whose listing revision advanced. `packages/client/connection/tests/fixture-browser-workspace.client.spec.ts` observes the committed URL after navigate. `apps/web/tests/browser-dock.snapshot.ts` pins expanded Dock chrome after open and Refresh against `about:blank`.
