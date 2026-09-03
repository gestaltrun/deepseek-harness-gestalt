# Agent Note: Paint the phone glyph in the Desktop overlay + menu

Status: implemented

English | [中文](2026-09-03-desktop-overlay-phone-menu-icon.zh.md)

## Problem

The Desktop sidebar `+` menu paints Files, Source Control, Tasks, Side Chat, Terminal, and Browser with leading glyphs, but the 手机 row is text-only. The same window's phone tab already shows the handset. TabBar serializes `icon: option.id` (`phone`) into the native overlay request; `overlayMenuIcon` mapped only `editor|git|subagent|sidechat|browser|terminal`, so an unknown id returned undefined and the row omitted the icon. In-page Menu would receive `PhoneTabIcon`, but Desktop always uses the overlay.

## Decision

`overlayMenuIcon('phone')` returns an overlay-local 16×16 monochrome handset matching `PhoneTabIcon` (viewBox `0 0 16 16`, stroke 1.3, `currentColor`). ui-primitives has no phone glyph. ui-phone already depends on ui-desktop, so importing `PhoneTabIcon` would cycle. Unknown ids still return undefined.

## Alternatives considered

**Import `PhoneTabIcon` from ui-phone.** Rejected: ui-phone already lists ui-desktop as a peer; the overlay package cannot take that import.

**Add a primitives phone icon and share it.** Rejected for this fix: no existing primitives glyph, and lifting the handset is a broader icon-set change than restoring the missing overlay row.

## Consequences

Desktop overlay `icon: 'phone'` rows render the same handset as the tab strip. A later primitives extraction can replace the overlay-local SVG without changing the id map.

## Testing

`packages/client/ui-desktop/tests/desktop-chrome-overlay.client.spec.tsx` requires `overlayMenuIcon('phone')` to be truthy, a menu item with `icon: 'phone'` to contain the 16×16 SVG, and unknown ids to stay undefined.
