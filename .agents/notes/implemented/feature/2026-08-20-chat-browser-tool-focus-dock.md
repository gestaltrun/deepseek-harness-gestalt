# Agent Note: Chat browser tool-call selection focuses the listed Dock tab

Status: implemented

English | [中文](2026-08-20-chat-browser-tool-focus-dock.zh.md)

## Problem

Selecting a Browser tool call, page event, or link in conversation must focus the matching Browser Dock tab. Delivered wiring only opened the details column and wrote the chat selection (`ChatView.openDetails` → `select` + `layout.openDetails()`). It did not resolve the `browser_*` target or call `browserWorkspace.focus`. The Native Browser Dock never carried this path.

## Decision

`ChatViewInjected.openDetails` still writes the selection and opens details. When the selection names a `browser_*` call, conversation then resolves that call's Browser tab from the current snapshot and focuses it through `remote.browserWorkspace.focus` with the listing revision from the Session `browserWorkspace` projection.

Args win when they already name a complete target (`browser_navigate` and the other addressable verbs). `browser_create` carries the minted target only on the settled result text. The helper lives in `ui-conversation` and treats `remote.browserWorkspace` as optional so a composition without Browser still loads.

Focus uses the addressed listing row's revision, the same contract as Dock chrome and the collapsed preview. It does not send a revision from the tool result, which can already be stale.

When the tab is absent from the listing, details still open and focus is not called. The path does not synthesize a 409 and does not add a second error chrome. A rejected focus is swallowed because details already opened.

Selection focuses the listed tab so the collapsed preview can highlight it. Browser Workspace carries no panel presentation state; better-sidebar remains the only authority for whether the panel is open.

The conversation transcript has no separate page-event or link gesture. Those selections, when they exist, share this `openDetails` path. Only `browser_*` tool rows call `selectCall` on click; ordinary tool rows stay inert.

This extends the collapse and preview rules in the [Native Browser Dock Agent Note](2026-08-19-browser-dock.md) and the per-tab listing revision in the [Dock tab revision Agent Note](../bug-fix/2026-08-20-dock-tab-revision.md).

## Alternatives considered

**Reopen the Dock whenever chat selects a Browser tool.** Rejected because collapse is a Session fact: after the human collapses the Dock, later activity must not steal it open. Focusing the listed tab is enough for the collapsed preview to highlight the match.

**Send the tool-result revision.** Rejected because independent navigations diverge per-tab revisions. The listing row is the Session authority the Dock already sends.

**Depend on `dsh-browser-workspace` from conversation.** Rejected because conversation must stay loadable without Browser. Structural listing reads plus an optional Remote keep the package boundary.

**Observe chat selection from `ui-browser` and focus there.** Rejected because the missing resolve already belongs on `openDetails`, and a second subscriber would duplicate the listing-revision contract.

**Show a missing-tab error in conversation.** Rejected because no existing chrome covers a gone Dock tab, and details already opened.

**Open details for every tool row.** Rejected because assembled tests and the current details limitation keep ordinary bash and file rows inert.

## Consequences

A listed `browser_*` card click opens details and focuses that tab without changing Dock visibility. A gone tab still opens details and does nothing else. Ordinary tool rows still have no details entry.

## Testing

`packages/client/ui-conversation/tests/browser-tab-focus.client.spec.ts` pins args vs result identity, the listed revision, tab-gone, and a rejected focus. `apply-inject.client.spec.tsx` pins inject-level focus. `packages/client/ui-tool/tests/toolview-slot.client.spec.tsx` clicks a real `browser_navigate` card through the conversation+tool stack and requires `focus(sessionId, target, listedRevision)`. The keyless fixture Session still has one tab, so the assembled snapshot cannot exercise two-tab chat selection.
