# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

DeepSeek Gestalt Desktop Host. Electron owns the window, menu, GitHub auto-update, and in-process Browser Runtime `webContents`. It starts bundled official Node plus `dsh web --host 127.0.0.1 --port 0 --patch ./cordis.patch.yml` and loads that loopback URL. The overlay adds Schedule, the GESTALT badge, drag strip, Update Control, and the Tandem-shaped HTTP client pointed at the Host's loopback Browser origin; the control remains absent until an update is actionable or an error follows version discovery. Browser `dsh web` does not load the overlay and keeps the deterministic Browser Runtime.

Closing the last window on every platform first drains the Relay with the `window-close` reason; Ctrl+C, quit, and smoke-test completion cancel any pending start, stop the Personal Pairing and production-gated Relay owners, stop the Web Host, dispose hidden Browser windows, and wait for their work to drain before Electron terminates. System sleep stops Remote Access; resume reloads it only for the still-signed-in Account. The source Electron smoke reads each Relay owner state after sleep, disable, window close, and quit, then checks the Web Host child PID is gone. Startup or a later Host crash gets one retry before the window shows the Host error. There is no windowless daemon, background Host, or remote wake path. Chromium persist partitions live at Electron `userData/Partitions/<name>`; the loopback API token lives under `userData/browser-runtime` and never under Tandem Browser Application Support. The Dock remains a native pane of screenshot, title, and text.

The main window accepts navigation only within the active loopback Host origin. Ordinary HTTP links, including GitHub authorization, open in the system browser; other origins and schemes cannot replace the Session Surface or create another Electron window. Platform Account signing keys and tokens stay in an environment-specific `safeStorage`-encrypted file under Electron userData. The preload exposes only current state and lifecycle verbs.

Personal Pairing is configured only in the real `手机配对` Settings section. The preload exposes Mobile Access, challenge, pending-confirmation, and paired-device verbs without adding status to the normal Session header, sidebar, approval, composer, or offline views. Each paired-device row renders the authenticated Mobile name and platform plus lease-derived online state, pairing time, and last authenticated Relay access. After Account sign-in, the Host-owned controller signs a fresh current-Installation proof for each operation, creates XKpsk3 invitation state locally, and forwards only opaque mailbox messages. On confirmation, Desktop creates distinct pairing-scoped Desktop and Mobile P-256 credentials, submits only their SHA-256 public-key digests to Platform, seals the Mobile grant with the first Snow transport payload, and retains the restart-safe confirmation transaction and reconnect record in a `safeStorage`-protected owner-only atomic file. The same owner runs one pairing-scoped WSS lifecycle per Desktop credential only while Mobile Access is enabled and stops it on disable, sign-out, sleep, window close, or quit. `SnowDesktopAttachmentOwner` admits only a currently projected route/selector/attachment/generation-bound IK request. Grant rotation, revocation, attachment replacement, and connection loss cancel pending accepts; a late result is disposed before any channel publication or Relay send. A candidate channel and Desktop revision become active only after both IK2 and the versioned encrypted `foreground-sync` reach the current attachment; either send failure disposes the candidate and leaves a new IK retry available. Development selects no keyless product controller.

Desktop Platform Account reads one operated production identity from `operated-platform.json` beside the packaged main entry. The build requires an explicit source file, rejects missing or unknown fields, and reconstructs the application-archive artifact from the `production` marker plus the public origin, callback, GitHub client id, credential reference, PostgreSQL database identity, and identity namespace; it never copies caller-supplied JSON or embeds the OAuth secret. Localhost, non-HTTPS origins, and callback mismatch fail module startup before Electron creates a window, starts the Web Host, reads Account storage, or sends traffic. Unavailable operating-system encryption remains a visible capability failure. The encrypted record is replaced through `dsh-atomic-write` with a random exclusive sibling, owner-only permissions, symlink-safe rename, and failure cleanup.

On macOS, a 28px top inset keeps the unchanged DSH sidebar header below the traffic lights. Windows uses a full-window 36px drag row with 46px minimize, maximize, and close targets. Unsupported development platforms keep the system frame.

Desktop owns `build/icon.icns`, `build/icon.ico`, and `build/icon.png` as byte-for-byte copies of the tracked 千机·Gestalt production artwork. electron-builder uses the ICNS for macOS and edits the ICO resources into the unsigned Windows executable; the release workflow verifies the largest source ICO frame in that PE file. The main build copies the PNG below the unpackaged Electron application path for the macOS Dock and Windows window, while packaging installs the same PNG as an explicit extra resource.

Dock / Start Menu cwd is the Launch Directory (`defaultWorkspace` under Application Support / `%APPDATA%`). User data stays in `~/.dsh`.

## Schedule and capability defaults

Every new Desktop Session exposes `schedule_create`, `schedule_list`, and `schedule_delete`. An absolute `schedule_create.at` value must carry an explicit offset or `time_zone`. Desktop does not mount `@deepseek-ai/dsh-time-context`; the Schedule Web overlay remains the composition that injects per-step time readings.

The conversation header places a Schedule task board immediately after background jobs whenever the current Session retains reminders. Its count includes waiting and overdue reminders but excludes paused ones. The board reads an independent Session projection and supports durable pause, resume, and two-step inline delete; it has no create form and does not infer state from tool transcript cards.

Schedule delivery is `session-local`: the original Session runs reminders only while live, and reopening it attempts overdue work. Closing DeepSeek Gestalt produces no operating-system, browser, email, SMS, or other external notification.

The locked Web Host snapshot contains packages that the Desktop default does not activate. It configures no MCP server, keeps the Cordis self-modification and Code Mode / PTC presets selectable instead of making either the default, leaves the `subagent_codex` and `subagent_claude_code` templates disabled in the standard preset, and exposes `web_search` without `web_fetch`. Production HMR stays disabled, and full-text Session search remains opt-in (`session-query-sqlite` uses `openAt: never`). The headless, ACP, and JSON-RPC examples are alternate application compositions rather than Desktop plugins.

## Develop

```sh
pnpm install
DSH_DESKTOP_OPERATED_PLATFORM_CONFIG=/absolute/path/to/operated-platform.json pnpm gestalt:dev
```

The config file contains the `production` marker and six public identity fields documented above; it contains no other field or OAuth secret. The process also needs a real Node on `DSH_NODE` or `npm_node_execpath` (pnpm sets the latter). Do not point Electron at its own execPath.

## Release

Run the `Desktop Release` workflow from `master` with the package version and `publish` selected. Both pack jobs project the public operated Platform identity from the same GitHub Environment variables used by Platform deployment and require the packaged application to start without runtime Platform environment variables. macOS arm64 and x64 install dependencies on matching GitHub runner architectures; publish builds use the `desktop-release` environment to sign and notarize, while dry runs receive no release credentials. Windows NSIS is unsigned and still updates. The workflow verifies each official Node archive, starts every packaged target, round-trips the disabled updater status through the Desktop bridge, waits for that status to reach the renderer, requires the inactive Update Control to remain absent, checks the signed and stapled Mac applications, creates the `gestalt-v<version>` tag and a draft Release at the tested commit, uploads and verifies the exact installer, blockmap, and updater-feed set, then publishes the Release. A failed or interrupted handoff removes the tag and draft owned by that run. On macOS the Update Control shows preparing after the zip lands while Squirrel copies the bundle aside; Install and restart appears only when that stage finishes. Ordinary quit still does not install.

Each published version requires a bilingual manifest under `release-notes/` with an explicit baseline kind, repository, and commit. Before creating a tag, the workflow validates the manifest version and derived tag, confirms that baseline is an ancestor of the tested commit, derives the commit count from Git, and renders the draft body to a notes file. The `0.1.0` manifest uses the `official-upstream` baseline `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`; its body links the complete comparison from that commit to `gestalt-v0.1.0`. The `0.1.1` manifest uses the `previous-release` baseline `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@de2610c9590f2e5b33ab366eb338f7c42058b11b` (`gestalt-v0.1.0`). The `0.1.2` manifest uses the `previous-release` baseline `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@a7482b9709e4631d624f6b471ef2aeec249baf7d` (`gestalt-v0.1.1`). The `0.1.3` manifest uses the `previous-release` baseline `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@4bbbf74a07799fb681e033288fb55b3b16fc08c0` (`gestalt-v0.1.2`). The `0.1.4` manifest uses the `previous-release` baseline `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@f5d133a9c00138b1a3e7ce180118b8262f38399a` (`gestalt-v0.1.3`). The `0.1.5` manifest uses the `previous-release` baseline `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt@a2a4c245c7a177891bdbf7238279136e63625a34` (`gestalt-v0.1.4`).

Local unsigned arm64 rehearsal (no notarization):

```sh
node apps/desktop/scripts/fetch-node.mjs --platform darwin --arch arm64
pnpm --ignore-scripts --config.node-linker=hoisted --config.inject-workspace-packages=true \
  --filter @deepseek-ai/dsh deploy --prod apps/desktop/resources/dsh
node apps/desktop/scripts/isolate-dsh-snapshot.mjs
pnpm --filter @deepseek-ai/dsh-desktop package:unsigned
```

The hoisted deploy includes workspace packages without pnpm's linked virtual dependency graph. `pnpm deploy` still leaves a small number of `file:` links into the monorepo; the isolate step copies those targets so the packed Web Host can resolve `dsh` outside the repo and the Windows installer never archives directory junctions.

## Known Limitations and Deferred Work

- **Packaged extraResources Node + dsh snapshot is assembled by the release workflow** — `gestalt:dev` runs the workspace source tree.
- **Windows Authenticode is absent** — SmartScreen warns; the updater still runs.
- **External release evidence remains** — the exact Snow/WASM implementation requires independent security review, and the shipped flow requires physical Desktop plus WKWebView/Android WebView evidence. Local Vite, test certificates, and `prototype-companion` are not product acceptance.
