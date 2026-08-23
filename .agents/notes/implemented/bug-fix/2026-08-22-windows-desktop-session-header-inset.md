# Agent Note: Windows Desktop Session Header Inset

Status: implemented

English | [中文](2026-08-22-windows-desktop-session-header-inset.zh.md)

## Problem

Windows Desktop Host is frameless and paints a full-width 36px drag strip with caption buttons. The sidebar already reserved 42px above its controls. The center Session column kept a zero top inset, so `conversation.session.header.actions` (subagent catalog, background jobs, scheduled tasks) sat under the strip. Browser `dsh web` has no `window.dshDesktop`, so the same Host URL showed those actions.

## Decision

AppFrame insets the center Session column 36px when the Windows chrome marker is present, matching the shared Window Chrome height already used by macOS. The [Desktop Host Agent Note](../architecture/2026-08-16-deepseek-gestalt-desktop-host.md) records the chrome geometry.

## Alternatives considered

**Narrow the drag strip to the sidebar plus caption buttons.** Rejected because a frameless Windows window still needs a full-width drag row to move the window.

**Raise Session header z-index above the strip.** Rejected because the strip is `-webkit-app-region: drag` and would still capture pointer events on those actions.

**Leave Windows uninset.** Rejected because the Session header is then not visible or clickable in the Electron shell.

## Consequences

Windows Desktop Session content starts below the drag strip. Browser composition is unchanged. Caption buttons stay at the right edge of the strip.

## Testing

`packages/client/ui-layout/tests/app-frame.client.spec.tsx` pins the 36px macOS and Windows center-column padding in AppFrame CSS. `apps/web/tests/desktop-chrome.e2e.ts` measures assembled Session Surface inset and padding for both chrome markers.
