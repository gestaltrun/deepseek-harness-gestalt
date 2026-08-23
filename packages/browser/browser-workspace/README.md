# @deepseek-ai/dsh-browser-workspace

English | [中文](README.zh.md)

Session-owned Browser Workspace binder. `ctx.browserWorkspace` binds Browser Runtime identities to one Session log so each Session independently owns zero or more Workspaces, instances, and tabs.

## Service API

`create`, `navigate`, `observe`, `screenshot`, `focus`, `input`, and `close` require the owning `Session`. `create` is also `@Remote('create')` so Client `remote.browserWorkspace.create` can mint a Session-owned tab. Creates are serialized; when attach is omitted, a retained shared or named persistent Profile reuses an open matching browser instance in the current Session, while temporary Profiles remain distinct. During matching, a logged target that the current Runtime reports as `BROWSER_NOT_FOUND` is forgotten before create continues; other observe failures still reject create. This lets the next create replace pages lost with a Runtime process restart without treating durable ownership as a live page. A missing Session ownership rejects with `BROWSER_SESSION_MISMATCH`. A target already owned by another live Session rejects with `BROWSER_TRANSFER_UNSUPPORTED`. Explicit attach to another live Session's Workspace or instance rejects with `BROWSER_TRANSFER_UNSUPPORTED`, and attach unknown to this Session rejects with `BROWSER_SESSION_MISMATCH`. The lock is the revision; each tab record stores the last committed Runtime revision. The Binder listens to `browser/runtime-state` and writes revision advances for an owned, unclosed tab, including advances that never entered a Binder verb. `observe` of a closed tab forgets the listing row. `snapshot` and `foldBrowserWorkspace` return the last logged whole Workspace, or the empty Workspace before the first change. `listBrowserWorkspacePages` is the canonical hierarchy flattening helper for Client consumers. `cleanup` closes leftover live Runtime tabs, forgets them from the Session snapshot, and is the returned work of `session/disposed`.

`browser/workspace` is a log-only, last-wins `SessionEventMap` member. When `ctx.sessionProjections` is composed, the package registers the `browserWorkspace` unit. Cross-Session page transfer is not supported.

## Model Experience

Indirectly, through dsh-tool-browser when a calling Agent Session is present. The Binder itself adds no model tokens.

#### KV Cache effect

Logged Workspace snapshots do not enter derived model history.

## Known Limitations and Deferred Work

- Dock chrome, width, and collapse state live in Client packages. This package persists only Session ownership, active identities, and each tab's last committed revision.
- Headless Browser Runtime snapshots compose Runtime and Consumer only. Session isolation is Binder-owned and is not claimed for those Binder-free traces.
