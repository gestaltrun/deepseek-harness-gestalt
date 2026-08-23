# Agent Note: Narrow-viewport Browser Dock overlay

Status: implemented

English | [中文](2026-08-21-narrow-browser-dock-overlay.zh.md)

## Problem

Desktop's default window is 1280px. The Browser Dock occupant's details range is 420/640/960, and the Session Surface keeps a 640px in-flow floor. With the default 280px sidebar those three tracks need 1340px, so the concession solver derives a zero in-flow details width on the default window and on any narrower laptop split.

The collapsed preview hides itself while `dockOpen` is true. Collapse lives on the Dock's right edge. The screenshot viewport used `overflow: hidden` and `object-fit: cover`. A human on a 1280px or clipped window therefore lost the expand control, could not reach collapse, and could not pan a page that did not fit the pane.

## Decision

`computeColumns` still derives a zero in-flow details track without rewriting the stored preference. When that preference is open, AppFrame paints the details occupant as a right-edge overlay of `min(clamped preference, remaining frame beside the sidebar)`. The overlay may drop below the occupant's minimum so chrome stays on-screen. `data-details-collapsed` is false while the overlay is painted; `data-details-overlay` marks the overlay. Drag uses the overlay width as its base. Widening the frame until the in-flow solve returns a positive details track removes the overlay.

The Dock viewport scrolls (`overflow: auto`) and paints the screenshot at its intrinsic size from the top left. The collapse control is `position: sticky; right: 0` inside the tab strip so a horizontal tab overflow does not cover it.

Official Browser chrome later left `details` ([workbench official browser Agent Note](../feature/2026-08-21-workbench-official-browser.md)). The overlay remains for other details occupants. This decision owns only the overlay and the scrollable viewport.

## Alternatives considered

**Show the collapsed preview while `dockOpen` is true and details is conceded.** Rejected because clicking expand would call `openDetails` and the solver would still derive zero in-flow width; the human would have a button that cannot reveal the page.

**Lower `CENTER_MIN` or the Dock minimum so 1280px stays in-flow.** Rejected because the 640px Session Surface floor and the 420px Dock minimum are the [#60](https://github.com/BeiKeJieDeLiuLangMao/deepseek-harness-gestalt/issues/60) range; shrinking them to fit one default window would clip chat or chrome on every width.

**Allow the frame to scroll horizontally.** Rejected because the three-column shell clips overflow by contract; a window scrollbar would hide collapse and the address field off the right edge, which is the defect.

## Consequences

An open Dock on a 1280px Desktop window covers the right of the Session Surface instead of vanishing. Collapse and take-control stay inside the visible overlay. A screenshot wider than the pane pans inside the viewport; it is no longer cropped by `object-fit: cover`. The stored details preference is still not the rendered truth.

## Testing

`packages/client/ui-layout/tests/columns.client.spec.ts` pins `overlayDetailsWidth` for a closed preference, a fitting 640px overlay, a clamped 960px overlay, and a remainder below the occupant minimum. `packages/client/ui-layout/tests/app-frame.client.spec.tsx` pins a 1280px Browser Dock overlay, a 1339px concession overlay that restores in-flow at 2000px, and `data-details-overlay` / `data-details-collapsed`.
