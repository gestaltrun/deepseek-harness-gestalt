# @deepseek-ai/dsh-client-ui-better-sidebar

English | [中文](README.zh.md)

Pinned source snapshot of [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar). The host half mounts `/sidebar` JSON, media, HTML preview, lazy-chunk, and terminal WebSocket routes behind the webServer trust fence. The client half publishes `ctx.betterSidebar` and paints the right sidebar plus bottom panel. SHA and refresh steps live in [UPSTREAM.md](UPSTREAM.md). Repository-owned edits are listed in [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md).

Product composition mounts this package and [`dsh-client-ui-workbench`](../ui-workbench/README.md). The adapter enables the snapshot browser tab and publishes official chrome from [`dsh-client-ui-browser`](../ui-browser/README.md); the sandboxed iframe remains the standalone fallback. Do not edit snapshot sources to change product behavior.

The Side Chat tab mounts the repository's declared `conversation` slot under the child Session id. The canonical Session header, registered Chat/Trajectory views, header actions, transcript, and InputBar therefore share the same components as the main conversation. The tab shell retains only thread lifecycle, switching, and promotion controls; inherited seed events remain durable but are hidden from this child-owned transcript. Session-scoped subagent lineage, schedules, and background jobs resolve against the child id. Workbench terminal tabs remain scoped by their own `SessionScope` and are not retargeted by the embedded conversation.

## Model Experience

### Side Chat

#### What the model sees

The persisted child Agent receives the parent log captured when the thread opens, followed by a plugin-stamped context injection containing the side-conversation boundary and any frozen in-progress parent output. The first question follows that injection. Each plugin activation owns its live Side Chat handles: unload closes route admission, waits for admitted calls, and disposes every handle while retaining persisted history.

#### Token effect

The child request includes the inherited parent log, the boundary injection, and the Side Chat question.

#### KV Cache effect

The inherited parent history remains a reusable prefix; the boundary injection and first question diverge after it.

### Optional terminal tools

#### What the model sees

When the Side Card setting `agentTerminalTools` is on, the snapshot host adds its optional `terminal_*` tool schemas. The tools stay absent until that setting is enabled.

#### Token effect

Enabling the setting adds the optional tool schemas to later requests.

#### KV Cache effect

There is no effect while `agentTerminalTools` is off. Enabling it invalidates a cached request prefix that omitted the optional tool schemas.

## Known Limitations and Deferred Work

- **Iframe browser implementation stays in the snapshot** — product composition replaces its rendered chrome through `workbenchBrowser`; a standalone snapshot install still uses the iframe.
- **Host fs/git/pty routes are the snapshot's own stack** — they do not yet consume the repository `fs` or `terminal` capability seams.
- **Right overlay plus official details Dock can both paint** — layout unification is deferred.
