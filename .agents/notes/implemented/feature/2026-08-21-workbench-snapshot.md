# Agent Note: Workbench snapshot without a second browser

Status: implemented

English | [中文](2026-08-21-workbench-snapshot.zh.md)

## Problem

The product needed the DSH-better-sidebar file tree, editor, terminal, Git, sub-agent, and Jobs workbench on Web and Desktop. The upstream plugin also ships a sandboxed iframe browser. Official Session browsing already lives on `browserRuntime` + `browserWorkspace` + [`dsh-client-ui-browser`](../../../../packages/client/ui-browser/README.md). A GitHub fork or a second monorepo would split the only product tree. Editing the snapshot to delete `BrowserView` would collide with each upstream source refresh. The snapshot is product UI, so its workspace identity must follow the `client/ui-*` package convention without breaking the upstream plugin identity used by settings and standalone installs.

## Decision

This repository stays the only monorepo. Upstream `omdsh-dev/DSH-better-sidebar` at `d9b8f15d9eab018742f97d67e54b2398504894cd` is a pinned source snapshot at [`packages/client/ui-better-sidebar/`](../../../../packages/client/ui-better-sidebar/README.md), rescoped to `@deepseek-ai/dsh-client-ui-better-sidebar`. The composed loader row uses `id: ui-better-sidebar`. The upstream `dsh-external/dsh-better-sidebar` plugin id, `dsh-better-sidebar` Cordis name, and settings namespace remain stable. The snapshot is not a `vendor/` Cordis package. [`UPSTREAM.md`](../../../../packages/client/ui-better-sidebar/UPSTREAM.md) defines the source-delta refresh, and [`LOCAL-MODIFICATIONS.md`](../../../../packages/client/ui-better-sidebar/LOCAL-MODIFICATIONS.md) lists the repository-owned replay.

[`packages/client/ui-workbench/`](../../../../packages/client/ui-workbench/README.md) is the first-party adapter. After the snapshot registers settings namespace `dsh-better-sidebar`, host apply writes `tabsEnabled.browser: true` and `browserInterceptLinks: false` so official chrome can occupy the snapshot browser tab. An absent `tabsEnabled.browser` key means enabled; a leftover `false` from the first mount is written `true`. The snapshot keeps file, editor, terminal, Git, sub-agent, Jobs, and official Browser tabs. [`dsh-web-app`](../../../../packages/bundle/web-app/README.md) inserts `id: ui-better-sidebar`, then the adapter, and keeps `id: ui-browser`. Occupancy of official chrome is owned by the [workbench official browser Agent Note](2026-08-21-workbench-official-browser.md).

[`dsh-client-ui-browser`](../../../../packages/client/ui-browser/README.md) registers settings section `id: 'browser'` on namespace `ui-browser`: `namedProfiles`, `defaultKind` (`shared` / `temporary` / `persistent`), and `defaultPersistentName`. `browser_create` that omits `profile` and sidebar `+ → Browser` read that default. The settings page does not create Browser Workspaces.

## Alternatives considered

**Fork plus a second monorepo.** Rejected because this repository already composes Host and Client packages, and a second tree would duplicate workspace constraints, coverage, and release versioning.

**Put the snapshot in `vendor/`.** Rejected because `vendor/` is the Cordis/foundation pin set. This plugin is a product UI overlay with its own host routes.

**Disable the iframe by deleting `BrowserView` in the snapshot.** Rejected because every upstream pull would reintroduce the file and fight the deletion.

**Run the iframe browser beside the official Dock.** Rejected because Session-owned browsing already has one occupant and one Runtime.

**Rename the upstream runtime and settings identities with the workspace package.** Rejected because `dsh-better-sidebar` identifies persisted preferences and the independently installable upstream plugin. The `ui-` convention governs this monorepo's workspace package and loader row, not the external plugin protocol.

**Migrate snapshot `/sidebar` pty, git, and fs onto official capability seams in this change.** Rejected because the workbench can mount on the snapshot stack first; seam migration is a later change.

## Consequences

Official Browser chrome occupies the snapshot `browser` tab; the Dock does not occupy `details`. Snapshot host routes stay on `/sidebar`. Host apply joins the snapshot loader fiber when the prefs namespace is not registered yet; calling `entry.init()` would apply the snapshot twice and duplicate `/sidebar` routes. Source launch serves lazy chunks from package `lib/`, not `dirname(import.meta.url)`. Coverage, Oxlint, jscpd, and knip skip the snapshot tree; adapter and official Browser tests own their integration behavior, while the assembled Web Side Chat snapshot pins the model-visible child-session path. Side Chat live Agent handles belong to one plugin activation; teardown closes admission, drains admitted calls, and releases every handle while keeping persisted history. The snapshot is not a `tsconfig.client.json` project because its references would merge host Context keys into the client program; `tsdown` emits `lib/types` with `noCheck`. The pre-release workspace has no alias for `@deepseek-ai/dsh-client-better-sidebar`; every in-repository consumer uses the UI-prefixed package.
