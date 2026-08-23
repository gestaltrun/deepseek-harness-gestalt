# @deepseek-ai/dsh-client-ui-better-sidebar

English | [中文](README.zh.md)

Pinned source snapshot of [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar). The host half mounts `/sidebar` JSON, media, HTML preview, lazy-chunk, and terminal WebSocket routes behind the webServer trust fence. The client half publishes `ctx.betterSidebar` and paints the right sidebar plus bottom panel. SHA and refresh steps live in [UPSTREAM.md](UPSTREAM.md). Repository-owned edits are listed in [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md).

Product composition mounts this package and [`dsh-client-ui-workbench`](../ui-workbench/README.md). The adapter enables the snapshot browser tab and publishes official chrome from [`dsh-client-ui-browser`](../ui-browser/README.md); the sandboxed iframe remains the standalone fallback. Do not edit snapshot sources to change product behavior.

## Model Experience

Indirectly, through the snapshot host's optional `terminal_*` tools when the Side Card setting `agentTerminalTools` is on. Those tools are owned by this snapshot's host half and stay off until that setting is enabled.

#### KV Cache effect

None while `agentTerminalTools` is off. Enabling it adds tool schemas to later requests and invalidates a prefix that omitted them.

## Known Limitations and Deferred Work

- **Iframe browser implementation stays in the snapshot** — product composition replaces its rendered chrome through `workbenchBrowser`; a standalone snapshot install still uses the iframe.
- **Host fs/git/pty routes are the snapshot's own stack** — they do not yet consume the repository `fs` or `terminal` capability seams.
- **Right overlay plus official details Dock can both paint** — layout unification is deferred.
