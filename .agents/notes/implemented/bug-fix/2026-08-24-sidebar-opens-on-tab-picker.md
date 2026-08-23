# Agent Note: Sidebar opens on the tab type picker

Status: implemented

English | [中文](2026-08-24-sidebar-opens-on-tab-picker.zh.md)

## Problem

A fresh Session prepopulated the sidebar with a pathless `editor` tab titled by the English literal `Files`. The `+` menu independently offered the same `editor` type under the current locale, and pathless editors deliberately have no deduplication key. Selecting the localized Files option therefore created a second tab for the same page. Language selection exposed the two origins through different labels but did not create the duplication.

## Decision

Fresh Session state contains one empty pane. The existing empty-pane cards render every enabled tab type from the same registry data as the `+` menu, and selecting a card opens that type through the ordinary service path.

Layout sanitization removes the automatic Files home emitted by the former default. Its record is identified by the complete owned signature: an `editor` type, English `Files` title, no path, a generated `tab:<number>` id, and object metadata. User-created Files homes use the stable `editor` id, while opened files carry a path; both remain persisted.

## Alternatives considered

**Localize the automatic tab title.** Rejected because it would hide the label mismatch while retaining two independent entry points and an implicit Files priority.

**Deduplicate every pathless editor.** Rejected because deduplication would make an explicit Files home globally special and would not provide the neutral type picker on first open.

**Remove every persisted pathless editor.** Rejected because it would delete tabs the user explicitly opened from the picker or `+` menu.

## Consequences

Opening a fresh sidebar requires an explicit tab-type choice and gives every enabled type equal placement. Loading an existing layout removes only the automatic Files record; explicit editor homes and file tabs remain. Component tests pin the empty fresh state, visible type cards, and the migration discriminator. The assembled Web replay snapshots the fresh picker and opens Side Chat through its card.
