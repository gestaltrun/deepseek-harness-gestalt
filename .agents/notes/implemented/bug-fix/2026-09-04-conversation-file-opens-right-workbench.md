# Agent Note: Conversation file opens land in the right workbench

Status: implemented

English | [中文](2026-09-04-conversation-file-opens-right-workbench.zh.md)

## Problem

`openTab` lands in `activePane`. Expanding the bottom panel, clicking its `+` menu, or auto-opening a terminal makes that bottom pane last-touched. A later conversation path, produced-files chip, explorer row, or `sidebar_open` file then opened in the bottom workbench instead of the right sidebar.

## Decision

`BetterSidebarService.openTab` is the single landing home. A seed with a path or URL whose `activePane` is in the bottom tree is retargeted to the first right-workbench leaf before minting, so a URL-only browser tab (path patched after create) follows the same rule as a file. Type-only `+` clicks have neither field and still follow the pane that owns the menu. An existing instance still focuses wherever it already lives, including a float. A focused right-workbench split is left alone.

## Alternatives considered

**Always land `openTab` in the right workbench.** Rejected because the bottom `+` menu and first-expansion auto-terminal must keep creating tabs in the bottom pane.

**Pin only `openSidebarFile`.** Rejected because `sidebar_open`, produced-files chips, and URL takeover share `BetterSidebarService.openTab` / `openFile`, not that helper.

## Consequences

Conversation and agent file opens expand the right panel. Bottom-pane terminals and type-only tabs stay in the bottom workbench until the user drags them. Explorer "open to the side" still splits the source pane.

## Testing

`packages/client/ui-better-sidebar/tests/open-tab-landing.client.spec.ts` drives `openTab` with a pathed editor, a URL browser seed, and a type-only terminal while the bottom pane is active.
