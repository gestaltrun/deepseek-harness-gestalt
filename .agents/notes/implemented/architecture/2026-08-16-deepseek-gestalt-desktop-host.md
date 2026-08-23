# Agent Note: DeepSeek Gestalt Desktop Host

Status: implemented

English | [中文](2026-08-16-deepseek-gestalt-desktop-host.zh.md)

## Problem

`dsh web` is the only process that injects `window.__DSH_BOOT__` and serves the Session Surface. Users who want an installable window, GitHub version discovery, and auto-update cannot get that from the CLI or from opening the Vite entry. Reimplementing the Host inside Electron would fork the engine and break the existing workspace, picker, and session model.

## Decision

DeepSeek Gestalt is a Desktop Host: Electron owns the window, application menu, process lifetime, and update checks. On launch it starts a bundled official Node plus a locked `dsh web` Web Host (`--host 127.0.0.1 --port 0 --no-open`) and loads that loopback URL. Desktop Host owns the window, so spawn and the overlay keep the OS default browser closed ([Desktop Web Host `--no-open`](../bug-fix/2026-08-22-desktop-web-host-no-open.md)). The Web Host keeps every Host capability, including the native directory picker.

Electron supervises the Web Host through shutdown. Window exit, termination signals, and smoke completion cancel a pending start, stop the child, and wait for process exit before the Desktop Host terminates; an intentional shutdown cannot trigger the one-time crash respawn. The trusted main window stays on the active loopback origin, sends ordinary web links to the system browser, and denies other navigation and every new Electron window.

The first Desktop Bundle is `0.1.0`, independent of the npm `dsh` line. The app id is `com.gestalt.deepseek`. Display name is DeepSeek Gestalt. Feed is GitHub Releases on `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt` (`gestalt-v*` tags, non-prerelease). Each macOS target installs and deploys on a matching runner architecture before notarization with the 千机 team identity; Windows ships unsigned NSIS and still updates. Downloaded updates never install on an ordinary quit. The Update Control shows a truncated integer download percent. On macOS, after the zip lands the control stays in `preparing` until native Squirrel finishes staging; Install and restart is offered only then. `before-quit` does not cancel Electron quit while the updater is installing, so `quitAndInstall` can replace the application. On macOS, `autoInstallOnAppQuit` only prefetches the zip into Squirrel after download.

Desktop owns ICNS, ICO, and 512x512 RGBA PNG application artwork under `apps/desktop/build/`. Those files preserve the bytes of the tracked 千机·Gestalt production assets from source commit `70ddb80bdfc713493dea8c3fc451817365a63f06`: the pinned SHA-256 digests are `da6a1174df80af2efadf763b22f8bc37f355680f8315f9ab78a8c59991c60e25`, `46a26b6a0e98e4a96e6151d7627b3a779af57c9214ff960a8447c618cfd88387`, and `8eb4eb7cc767a5d929fee6715e78d5360ebca184996d757ffef18db90319c802`, respectively. electron-builder uses ICNS for macOS and edits ICO resources into the unsigned Windows executable. The release workflow requires the PE file to contain every maximum-resolution source ICO frame before smoke and upload. The PNG is a packaged runtime resource, an unpackaged macOS Dock icon, and the Windows BrowserWindow icon; packaged macOS keeps the ICNS-derived application icon.

The Desktop Release manual dispatch runs from `master` with an explicit Desktop Bundle version. A publish run verifies that version against `apps/desktop/package.json`, rejects an existing tag, and packages macOS only inside the `desktop-release` environment, whose branch policy admits `master` and supplies the certificate plus Apple notarization secrets. Credential-free runs use a separate environment and explicitly disable macOS identity selection and notarization. The CLI composition explicitly supplies the service definitions used by its Web and headless providers, so a production-only deployment preserves the same plugin import closure as source launch. Each platform deploys a hoisted production snapshot with injected workspace packages, then materializes its remaining file links; the Windows installer therefore receives no pnpm directory junction graph for 7zip to traverse. Each publish build requires code signing and verifies the signed, stapled application before artifact upload. After both macOS architectures and Windows pass packaged smoke tests, the publish job validates the exact versioned installer, blockmap, and updater-feed set, validates a tracked bilingual release-note manifest against the tested Git history, and renders its notes file before creating an owned `gestalt-v<version>` tag and draft GitHub Release at the tested commit. Each manifest names an explicit baseline kind, repository, and commit; Git supplies the release target and commit count. The first bundle uses the `official-upstream` baseline `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a` and compares that commit with `gestalt-v0.1.0`; later bundles can use a `previous-release` baseline. The job uploads the assets, verifies the remote filenames, and then publishes the non-prerelease Release. A failed or interrupted handoff deletes the draft and tag owned by that run so the same candidate can be retried.

Desktop adds one `--patch` overlay after the Web profile: `@deepseek-ai/dsh-time-context` and `@deepseek-ai/dsh-schedule` follow the persistence and Agent services they require, then the GESTALT badge, drag strip, and Update Control join the Session Surface. Every new Desktop Session exposes `schedule_create`, `schedule_list`, and `schedule_delete`. Reminder delivery is Session-local: it runs only while the original Session is live, retries overdue work when that Session reopens, and sends no operating-system or external notification. Browser `dsh web` does not load the overlay, so Schedule and time-context remain opt-in there.

The Update Control occupies its sidebar seat only for actionable update phases and errors after version discovery; disabled, idle, checking, and pre-discovery errors remain absent. Dock launch sets the Web Host cwd to `~/Library/Application Support/DeepSeek Gestalt/defaultWorkspace` (Windows: `%APPDATA%\DeepSeek Gestalt\defaultWorkspace`) so the process cwd is not the install directory. Session Surface, `~/.dsh`, and the web profile stay shared.

Package presence in the locked Web Host snapshot does not activate a capability. Desktop configures no MCP server, keeps the Cordis self-modification and Code Mode presets selectable rather than default, retains disabled Codex and Claude Code subagent templates in the standard preset, and exposes Web search without Web fetch. Production HMR stays disabled, and full-text Session search remains opt-in because `session-query-sqlite` uses `openAt: never`. The headless, ACP, and JSON-RPC examples are alternate application compositions, not Desktop plugins.

Window Chrome uses one 36px row across the Desktop sidebar, center Session content, and top Workbench. On macOS, the sidebar and center portion is a continuous drag region around the traffic lights. The Workbench uses only its flexible unused space after `+` for window dragging; tabs, controls, and tab-drop handling remain interactive. Windows uses the same row with three non-drag caption buttons and a matching 36px center Session inset so the Session header stays below the strip ([Windows Desktop Session header inset](../bug-fix/2026-08-22-windows-desktop-session-header-inset.md)). Browser-only Web keeps the compact 34px Workbench tab strip and renders no window drag space. Unsupported development platforms keep their system frame.

The right and bottom Workbenches retain their preferred sizes while closed but contribute layout space independently only while visible. Resizing the bottom Workbench cannot apply a closed right Workbench's retained width, and the narrow floating drawer contributes no layout space.

## Alternatives considered

**Electron as the Web Host (`ELECTRON_RUN_AS_NODE`).** This rebuilds every native addon against Electron's ABI and forks engine behavior from CLI `dsh web`.

**One workspace per window, as in 千机·Gestalt.** The existing Session Surface already lists every Workspace in one sidebar.

**Official `deepseek-ai/deepseek-harness` Releases as the first feed.** The origin remote is the personal fork; moving the feed later breaks already-installed updaters.

**Authenticode on Windows before shipping updates.** electron-updater can update an unsigned NSIS install; SmartScreen is the cost. Mac still requires notarization.

**Replace the native directory picker with Electron's dialog.** That would change a Web Host capability. Desktop only adds the Apple Events entitlement so the existing osascript picker can run under Hardened Runtime.

**Create the release tag before dispatching the workflow.** The tag would identify an unchecked candidate and remain after a packaging or smoke failure. The publish job creates it with the Release only after every target passes.

**Enable every package present in the Desktop Bundle.** A package in the locked snapshot is resolution inventory, not product authorization. Defaulting trusted MCP commands, self-modification, alternate tool presentation, or product-specific subagent providers would expand the Desktop capability set without a user decision; the overlay activates only the Session-local reminder pair required by this product.

**Use GitHub-generated Desktop release notes.** Generated notes enumerate merged pull requests but do not establish an official upstream baseline, complete product categories, or equal Chinese and English content. A tracked manifest and verified renderer own those facts.

## Verification

- `pnpm gestalt:dev` starts Desktop Host, which starts Web Host and loads `window.__DSH_BOOT__` at a loopback URL (not a bare Vite server).
- Browser `dsh web` keeps the HARNESS badge, has no drag strip, and has no Update Control.
- Desktop composition shows the GESTALT badge and a drag strip above the logo row. Update Control render tests keep inactive phases absent and actionable phases on the same foot row as Settings.
- macOS expanded and collapsed layouts align the sidebar, center Session content, and top Workbench on the 36px Window Chrome; its center area and unused Workbench space drag the window without swallowing tabs or controls. Windows keeps its caption buttons at the right edge of the same row and insets center Session content by 36px. Browser-only Web keeps the interactive 34px tab strip without a window drag node.
- Resizing the bottom Workbench while the right Workbench is closed preserves the Session list width and the center column's horizontal bounds; each panel's retained size affects layout only while that panel is visible.
- Dock-style spawn uses the Launch Directory as cwd and does not register that path as a Workspace.
- Desktop shutdown waits for pending and running Web Host processes to exit; the smoke test rejects an orphaned child, missing Desktop composition or updater bridge, an updater status that has not reached the renderer, and a visible inactive Update Control. The packaged smoke drains Electron stdout/stderr so a Windows pipe cannot stall startup, and fails if the process exits before writing `ok`. A missing or invalid Platform Account deployment pair disables Account and Pairing and still starts the Web Host. First-run Platform Account start keeps the installation id in memory and does not encrypt a record until a login attempt, and Web Host startup does not wait for that start.
- The keyless browser golden boots the shipped Web profile plus Desktop overlay; release jobs verify Node archive digests, raise the open-file limit to the runner hard limit, and apply a bounded `@electron/osx-sign` resource walk before macOS signing. Publish builds require code signing plus a stapled notarization ticket, and each packaged target is smoked before upload.
- A boot-free keyless CLI check composes the real Web profile plus Desktop overlay, requires time-context and Schedule after their services, and proves the default browser-only tree lacks them. An assembled keyless Desktop turn snapshots both time-context messages, all three Schedule schemas, the `schedule_list` call and result, and the final assistant reply.
- The Desktop icon tests pin all three source digests and their container signatures, require a 512x512 RGBA PNG, check macOS, Windows, packaged-resource, Dock, and BrowserWindow wiring, and reject a Windows PE file without the maximum-resolution ICO payload.
- Release-plan tests cover version, branch, and existing-tag validation; release-note tests cover bilingual rendering, manifest completeness, version and tag agreement, Git ancestry, commit counting, and workflow ordering; release-asset tests require both updater feeds and every versioned macOS and Windows installer plus blockmap while excluding unpacked application contents.
- Unit tests cover URL discovery from the `dsh web:` line, Launch Directory resolution, updater phase transitions without downloading, integer download percents, and leaving `before-quit` unblocked while quitAndInstall runs.

## Consequences

- A Desktop release is a snapshot of `dsh` plus Electron. The private Desktop app is not an npm `dsh` release-family member, so both version lines remain independent.
- Desktop users receive Session-local reminders by default; browser-only Web users opt in explicitly, and neither host gains external notification.
- The notarized Mac identity belongs to the 千机 Apple team. Changing the app id later is a new application.
- Windows users see SmartScreen until an Authenticode certificate exists.
- The personal GitHub feed is the product feed; there is no migration path that preserves updates for already-installed builds.
- A publish dispatch cannot start packaging until the `desktop-release` environment contains `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
