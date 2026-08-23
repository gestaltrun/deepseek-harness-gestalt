# @deepseek-ai/dsh-client-ui-workbench

English | [中文](README.zh.md)

First-party adapter beside the [`better-sidebar` snapshot](../better-sidebar/README.md). Host apply joins the snapshot loader fiber when namespace `dsh-better-sidebar` is not registered yet, then writes `tabsEnabled.browser: true` and `browserInterceptLinks: false`. The client half publishes `workbenchBrowser`, requests `@deepseek-ai/dsh-client-ui-browser/client` from the module table, and binds each official Workspace page to one snapshot `browser` tab. Browser Workspace owns Profile-matched instance reuse when `+ → Browser` creates another page; better-sidebar owns per-Session panel visibility. The Desktop overlay document publishes the face without reconciling official pages. Daily product changes belong here, not in the snapshot tree.

Web-app composition inserts the snapshot row, then this adapter, then keeps `id: ui-browser`. Occupancy is specified by the [workbench official browser Agent Note](../../../.agents/notes/implemented/feature/2026-08-21-workbench-official-browser.md).

## Model Experience

None, as this adapter only patches snapshot prefs and pairs official pages with sidebar tabs; it registers no prompt, schema, stream, or tool.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Snapshot fs/git/pty stay on `/sidebar`** — this phase does not migrate them onto official `fs` or `terminal` capability seams.
