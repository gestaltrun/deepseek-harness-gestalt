# Agent Note: the Sub2API offer card and its one-click installer live in the Desktop Host

Status: implemented

English | [中文](2026-08-28-sub2api-offer-card-installer.zh.md)

## Problem

The Sub2API sidecar (#346, bundle source in the sidecar repository) needed a Desktop-only enablement path. The Web Host is a spawned child, so nothing inside its composition could own downloads, profile writes, or its own lifecycle, and the card had to render a state machine driven by whoever owned that work. The GitHub Release that will host the artifacts is not published — release mutations need separate approval — so enablement also needed an honest unpublished state and a local-fixture path for development and testing.

## Decision

The Desktop Host main process owns everything; the card only renders. `DesktopSub2ApiController` (apps/desktop/src/sub2api.ts) runs the phase machine `missing → downloading → verifying → installed → starting → running / error`, pushes every transition over a new `sub2api:snapshot-changed` IPC event (the same posture as updater and pairing snapshots), and takes the six verbs through the preload bridge. The Host probe polls `GET <web-host>/plugins/dsh-sub2api/quota-snapshot` — a 2xx proves the bundle is mounted and the supervised chain is healthy, because the sidecar registers that route only after a healthy boot; a no-Origin request from the main process passes the sidecar's loopback-peer + loopback-Host admission.

The installer (apps/desktop/src/sub2api-install.ts) never shells out to pnpm or the `dsh` CLI: `fetch` streams both archives into an OS-temp staging directory, each archive is verified against its own `SHA256SUMS` (plus the runtime pack's inner sums after extraction), the bundle package lands at `$DSH_HOME/profiles/web/node_modules/<name>`, and the profile manifest gains exactly one `dsh.profile.bundles` row — publish.md's semantics, with every other entry preserved verbatim and the write locked (`withFileLock`) and atomic (`writeFileAtomic`). The runtime pack strips its top-level directory into `$DSH_HOME/sub2api/runtime`, which is the sidecar supervisor's `binaryDir` default.

Two decisions are worth recording because the ticket text said otherwise:

- **The pack extracts to `sub2api/runtime`, not `sub2api/run`.** The merged supervisor contract makes `<runtimeDir>/runtime` the `binaryDir` default and keeps `run/` for ephemeral state it may wipe on upgrade; extracting binaries into `run/` would break replace-on-upgrade and mix with `admin-password` and logs.
- **Disable writes a profile patch row, not a config override.** Patch rows replace a row's whole config, so an `enabled: false` override would have to restate the sidecar's full config. The installer writes the exact row `{ id: 'dsh-sub2api-sidecar', disabled: true }` into the profile's own `cordis.patch.yml` — entry-level disable, user-layer precedence, nothing else touched — and refuses to coexist with a user-owned row for the same id.

Rollback: any installer failure after the manifest patch restores the previous manifest text and removes this run's extraction, so the Web Host never boots a half-installed component. If the first restart after a fresh install fails, the controller removes the row and extracted files, restarts again, and reports the failure with the rollback prefix.

Downloads resolve from `DSH_DESKTOP_SUB2API_SOURCES` (a JSON file path, otherwise `sub2api-sources.json` beside the packaged main entry) holding the four artifact URLs. No file means the placeholder state: the card renders the offer, and enabling states plainly that the GitHub Release needs separate approval. A present-but-invalid file degrades to the unavailable controller carrying the reason rather than crashing Desktop boot.

The controlled restart (`replaceWebHost` in main.ts, also used by the crash-respawn path) stops the child, spawns a fresh one through the existing `spawn-web-host` seam, reloads the window and the native overlay onto the new port-0 URL, and re-points Companion RPC; sessions survive on disk. The desktop bundle grows by `tar`, `js-yaml`, and `@deepseek-ai/dsh-home-paths` — the install stays inside the app, and the installer size never carries the runtime pack.

## Alternatives considered

**Put the installer in the Web Host composition.** A bundle plugin could download and self-mount only by editing its own profile out from under a running Loader and restarting itself — the Host would still own the restart, and downloads would die with the child they control. Rejected: the Desktop main process already owns child lifecycle and outlives Web Host restarts.

**A Web Host RPC for start/stop.** The sidecar bundle would need a new control service, and the Renderer would reach privileged install verbs through the page's transport. Rejected for A2: it adds a bundle-side API the card cannot assume on older bundles; the profile patch row uses the documented override lever with zero bundle changes.

**Store the state machine in the renderer.** The card must survive window reloads across the restart it triggers, and two surfaces (main window + overlay document) render it. Rejected: the Host-pushed snapshot is the same discipline the updater and pairing snapshots already follow.

## Consequences

Browser `dsh web` has no entry point (ui-desktop is Desktop-overlay-only), and the card renders nothing without `window.dshDesktop`. The visible assembled evidence is the Desktop-composition overlay-document golden plus the offer-card scenario in `apps/web/tests/settings-chrome.e2e.ts`, driven by the typed bridge fixture. The `web` profile is pinned by name: the Desktop Web Host is `dsh web`, alias of `--profile web`, so the installer edits that one profile. A Web Host boot that fails with the bundle mounted still shows the Host error page with no card — recovery is re-running uninstall from a working boot or removing the bundles row by hand — accepted because the installer's rollback covers its own failure modes and the fail-loud boot error names the plugin.
