# Agent Note: Workbench `contain: layout` hides the tab strip

Status: implemented

English | [中文](2026-09-04-workbench-contain-layout-tab-strip.zh.md)

## Problem

Desktop Host presents each official Runtime page as a `WebContentsView` over the snapshot `browser` tab's viewport hole. With `contain: layout` on the absolutely positioned right and bottom workbench panels, Chromium reported the panel at a negative `y` while `top: 0` and the panel host stayed at the viewport origin. The tab strip sat off-screen, so the live page covered the sidebar tab list and looked like a second browser chrome instead of a tab inside the workbench.

## Decision

Right and bottom workbench panels use `contain: style` only. Official page chrome remains the snapshot `browser` tab in `ui-workbench` / `ui-browser`; Desktop still presents live `webContents` into `[data-browser-viewport]`. Floating windows keep `contain: layout style`.

## Alternatives considered

**Keep `contain: layout` and compensate `browserPresent` bounds.** Rejected because the tab strip itself was off-screen; shifting only the native page would still hide the page list.

**Pin the panel with a Window Chrome `padding-top`.** Rejected because the host is already viewport-sized; the defect was containment sizing the absolute panel, not missing chrome inset.

## Consequences

The workbench tab strip stays in the window. Official pages still overlay the viewport hole under the address bar, not a separate top-level browser. Panel drag isolation no longer uses layout containment.

## Testing

A live Desktop session with `contain: none` restored panel `y` from `-44` to `0`. Package CSS records the `contain: style` rule. The headed Desktop after rebuild showed `about:blank` tabs on the workbench strip rather than a covering native page.
