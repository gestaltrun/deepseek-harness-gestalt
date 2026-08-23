# Agent Note: Workbench snapshot without a second browser

Status: implemented

English | [中文](2026-08-21-workbench-snapshot.zh.md)

## Problem

The product needed the DSH-better-sidebar file tree, editor, terminal, Git, sub-agent, and Jobs workbench on Web and Desktop. The upstream plugin also ships a sandboxed iframe browser. Official Session browsing already lives on `browserRuntime` + `browserWorkspace` + [`dsh-client-ui-browser`](../../../../packages/client/ui-browser/README.md). A GitHub fork or a second monorepo would split the only product tree. Editing the snapshot to delete `BrowserView` would collide on every `git subtree pull`.

## Decision

This repository stays the only monorepo. Upstream `omdsh-dev/DSH-better-sidebar` at `50a888845fc614f63dfbf4d2b3704cc1004cd5c0` is a pinned source snapshot at [`packages/client/better-sidebar/`](../../../../packages/client/better-sidebar/README.md), rescoped to `@deepseek-ai/dsh-client-better-sidebar`. It is not a `vendor/` Cordis package. Refresh is `git subtree pull` plus the rows in [`LOCAL-MODIFICATIONS.md`](../../../../packages/client/better-sidebar/LOCAL-MODIFICATIONS.md).

[`packages/client/ui-workbench/`](../../../../packages/client/ui-workbench/README.md) is the first-party adapter. After the snapshot registers settings namespace `dsh-better-sidebar`, host apply writes `tabsEnabled.browser: true` and `browserInterceptLinks: false` so official chrome can occupy the snapshot browser tab. An absent `tabsEnabled.browser` key means enabled; a leftover `false` from the first mount is written `true`. The snapshot keeps file, editor, terminal, Git, sub-agent, Jobs, and official Browser tabs. [`dsh-web-app`](../../../../packages/bundle/web-app/README.md) inserts the snapshot row, then the adapter, and keeps `id: ui-browser`. Occupancy of official chrome is owned by the [workbench official browser Agent Note](2026-08-21-workbench-official-browser.md).

[`dsh-client-ui-browser`](../../../../packages/client/ui-browser/README.md) registers settings section `id: 'browser'` on namespace `ui-browser`: `namedProfiles`, `defaultKind` (`shared` / `temporary` / `persistent`), and `defaultPersistentName`. `browser_create` that omits `profile` and sidebar `+ → Browser` read that default. The settings page does not create Browser Workspaces.

## Alternatives considered

**Fork plus a second monorepo.** Rejected because this repository already composes Host and Client packages, and a second tree would duplicate workspace constraints, coverage, and release versioning.

**Put the snapshot in `vendor/`.** Rejected because `vendor/` is the Cordis/foundation pin set. This plugin is a product UI overlay with its own host routes.

**Disable the iframe by deleting `BrowserView` in the snapshot.** Rejected because every upstream pull would reintroduce the file and fight the deletion.

**Run the iframe browser beside the official Dock.** Rejected because Session-owned browsing already has one occupant and one Runtime.

**Migrate snapshot `/sidebar` pty, git, and fs onto official capability seams in this change.** Rejected because the workbench can mount on the snapshot stack first; seam migration is a later change.

## Consequences

Official Browser chrome now occupies the snapshot `browser` tab; the Dock no longer occupies `details`. Snapshot host routes stay on `/sidebar`. Host apply joins the snapshot loader fiber when the prefs namespace is not registered yet; calling `entry.init()` would apply the snapshot twice and duplicate `/sidebar` routes. Source launch serves lazy chunks from package `lib/`, not `dirname(import.meta.url)`. Coverage, Oxlint, jscpd, and knip skip the snapshot tree; adapter and official Browser tests own product behavior. The snapshot is not a `tsconfig.client.json` project because its references would merge host Context keys into the client program; `tsdown` emits `lib/types` with `noCheck`.
