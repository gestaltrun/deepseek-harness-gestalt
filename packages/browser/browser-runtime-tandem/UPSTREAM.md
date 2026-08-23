# Upstream provenance — Tandem Browser

- Upstream repository: <https://github.com/hydro13/tandem-browser>
- Pinned source revision: `3b613cfd4c299609ca7ca415d638c1b71c6ba5de`
- Upstream version at the pinned revision: 1.11.4
- Upstream license: MIT — Copyright (c) 2026 Robin Waslander (full notice in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md))
- Vendored source: none. This package is a protocol-only integration over Tandem's loopback HTTP API; it carries no upstream files and never launches Tandem.app. Production Desktop points the HTTP client at the in-process Electron adapter in [`dsh-browser-runtime-electron`](../browser-runtime-electron).
- Local modifications: none — no upstream source is carried, so nothing is modified.

The pinned revision is exported as `TANDEM_UPSTREAM_REVISION` and `TANDEM_UPSTREAM_VERSION` from `src/index.ts`; the Provider rejects protocol responses that the pinned revision does not produce.

## Upstream-contribution candidates

The evaluation that selected Tandem is [.agents/research/2026-08-17-agent-browser-runtime-options.md](../../../.agents/research/2026-08-17-agent-browser-runtime-options.md). Gaps that block treating the pinned revision as mature infrastructure, each a candidate for upstream contribution rather than a local fork:

- Isolated sessions created through `session.fromPartition()` do not receive the default session's network security stack (RequestDispatcher/Stealth) or extension loading.
- The session registry is memory-only; session lifecycle has no persisted or recoverable record.
- Storage erasure does not distinguish `close`, `forget`, and secure wipe; `destroy()` removes registry entries without clearing the partition's on-disk storage.
- The MCP surface exposes 257 tools with no allowlist or tool profiles, which is unsuitable as a per-request default tool surface.
- `GET /page-content` waits its full internal max-wait window (10 seconds at the pinned revision) whenever a page offers fewer than 1000 text characters; callers need `settleMs`/`timeout`/`minLength` query bounds for bounded observation.
- The HTTP API binds all interfaces with remote access enabled by default, leaving loopback confinement to each caller.
- Linux support is best-effort rather than a peer of macOS and Windows.
