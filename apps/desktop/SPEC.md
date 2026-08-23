# DeepSeek Gestalt Desktop Host

## Problem Statement

I can already run the DeepSeek Harness Session Surface in a browser with `dsh web`, but I cannot install a desktop app that wraps that same page, keeps my existing workspaces and sessions, and updates itself from GitHub Releases. Opening the Vite frontend alone whitescreens because only `dsh web` injects `window.__DSH_BOOT__`. Copying 千机·Gestalt's one-workspace-per-window desktop would throw away the current unified sidebar.

## Solution

Ship **DeepSeek Gestalt**, a Desktop Host: an Electron window that starts a bundled official Node plus a locked `dsh web` Web Host on loopback and loads that URL. The existing Session Surface stays in one window with many Workspaces in the sidebar. Its Desktop-only overlay adds Session-local Schedule tools, a window frame, a GESTALT badge, a drag strip, and an Update Control next to Settings. Reminders run only while their original Session is live, retry overdue work when that Session reopens, and do not send operating-system or external notifications. Browser-only `dsh web` is unchanged. Updates come from GitHub Releases on the personal fork, after the user confirms download.

## User Stories

1. As a developer who already uses `dsh web`, I want a Dock / Start Menu app, so that I do not have to start a terminal server to open the Session Surface.
2. As a Desktop user, I want the same sidebar of Workspaces and Sessions I already have in the browser, so that I do not relearn a one-window-per-workspace product.
3. As a Desktop user, I want my `~/.dsh` sessions and settings shared with CLI `dsh web`, so that I do not keep two identities.
4. As a Desktop user, I want the app to start the Web Host for me, so that I never have to run `dsh web` first.
5. As a Desktop user, I want the window to load only a loopback URL that carries `window.__DSH_BOOT__`, so that I never see the Vite white screen.
6. As a developer still using the browser, I want `dsh web` to look and behave as it does today, so that Desktop work does not tax the engine UI.
7. As a Desktop user, I want the product name DeepSeek Gestalt in the Dock, installer, and About box, so that I can tell it apart from Harness CLI.
8. As a Desktop user, I want the page wordmark to say deepseek GESTALT, so that the window matches the product.
9. As a browser user, I want the HARNESS badge left alone, so that the engine UI is not rebranded.
10. As a Desktop user, I want no system title bar and macOS traffic lights over a drag strip, so that the window feels like Codex, not a browser chrome.
11. As a Windows Desktop user, I want in-window minimize / maximize / close, so that a frameless window is still usable.
12. As a Desktop user, I do not want back/forward history in the title strip, so that the shell does not invent navigation the Session Surface does not have.
13. As a Desktop user, I want Settings to stay where it is, with Update Control on the same row to its right, so that I can check updates the way Codex places its control.
14. As a browser user, I do not want an Update Control at all, so that a page with no Desktop Host does not pretend it can update.
15. As a Desktop user, I want the app to discover a new Desktop Bundle on GitHub, tell me, and download only after I click, so that updates are never silent.
16. As a Desktop user, I want to quit and install after download, so that I can choose when the app restarts.
17. As a Desktop user, I want development builds to skip the update feed, so that a local run does not talk to GitHub.
18. As a macOS user, I want a notarized app, so that Gatekeeper and auto-update can install cleanly.
19. As a Windows user, I want auto-update even without Authenticode, so that I can still get new Desktop Bundles (accepting SmartScreen).
20. As a packager, I want macOS arm64 and x64 as two artifacts and Windows x64 NSIS per-user, so that electron-updater can pick the right file.
21. As a packager, I want a `gestalt-v*` tag plus a manual workflow to publish a non-prerelease GitHub Release, so that the feed is never a random commit.
22. As a Desktop user, I want the Web Host bound to `127.0.0.1` on an OS-chosen port, so that I do not fight a `dsh web` already on 3080 and never expose the Host on the LAN.
23. As a Desktop user, I want a single instance and a single window, so that a second Dock click focuses the existing app.
24. As a Desktop user, I want the Web Host to be official Node plus a locked `dsh`, so that native addons match CLI behavior.
25. As a Desktop user, I want Dock launch to use the Launch Directory (`defaultWorkspace` under Application Support / `%APPDATA%`), so that the install path or `/` never becomes a session cwd.
26. As a Desktop user with existing Workspaces, I want those groups to appear immediately, so that I am not asked to pick a folder every launch.
27. As a first-time Desktop user with an empty Workspace list, I want the existing "add a folder" flow, so that there is no new onboarding wizard.
28. As a Desktop user, I want adding a Workspace to keep the native directory picker, so that Desktop does not replace Web Host capabilities.
29. As a Desktop user, I want a failed Web Host to show an error in the window and retry once, so that the Desktop Host itself does not die with the child.
30. As a Desktop user, I want a cold start to show a blank window plus the drag strip until the URL is ready, so that I am not stuck on a custom splash.
31. As a developer, I want `pnpm gestalt:dev` to start Desktop Host which starts Web Host from the source tree, so that I can iterate without packaging.
32. As a developer, I want the Desktop overlay applied only through an extra `--patch`, so that the default web profile is not polluted.
33. As a Desktop user, I want the app id `com.gestalt.deepseek` and first Desktop Bundle `0.1.0`, so that updates and notarization have a stable identity.
34. As a Desktop user, I want the update feed to stay on the personal GitHub fork, so that already-installed apps do not lose their channel.
35. As a macOS Desktop user, I want an Apple Events entitlement so the existing osascript picker still works under Hardened Runtime.
36. As someone using Ungrouped sessions, I want those rows to keep meaning "session with no Workspace registration", so that Dock cwd is not "solved" by stuffing a fake project into Ungrouped.
37. As a Desktop user, I want every new Session to expose Schedule tools, so that reminders work without editing a profile.
38. As a Desktop user, I want reminder delivery to remain inside the original live Session, so that closing the app never implies an operating-system or external notification will arrive.
39. As a Desktop user, I do not want the OS default browser to open at startup, so that only the Desktop window shows the Session Surface.

## Implementation Decisions

- DeepSeek Gestalt is a new desktop product. The Harness Engine is `dsh`. Desktop Host is Electron. Web Host is bundled official Node running `dsh web`.
- Desktop Host starts Web Host with `--host 127.0.0.1 --port 0 --no-open` and a Desktop-only `--patch` overlay, then loads the loopback URL printed as `dsh web: http://127.0.0.1:<port>`. `--no-open` is required because `dsh web` otherwise hands that URL to the OS default browser, duplicating the Desktop window. The overlay also sets `web-runtime.openBrowser` to false.
- One window, one Web Host child, single-instance lock. A second launch focuses the existing window.
- Session Surface is unchanged: many Workspaces and Sessions in one sidebar. A Workspace is not a window.
- User data stays in `$DSH_HOME` / `~/.dsh` and the existing web profile. Desktop does not create a second home or a `gestalt` profile.
- Dock / Start Menu cwd is the Launch Directory: `~/Library/Application Support/DeepSeek Gestalt/defaultWorkspace` on macOS, `%APPDATA%\DeepSeek Gestalt\defaultWorkspace` on Windows. Create it empty if missing. Do not register it as a Workspace.
- Browser-only `dsh web` keeps its existing capability set. The Desktop overlay mounts Schedule after its required persistence and Agent services and does not mount time-context, while the native directory picker stays unchanged. Desktop adds the Apple Events entitlement for notarized macOS.
- Window Chrome: no system title bar. macOS traffic lights sit on a Desktop-only drag strip above the logo row. Windows paints its own caption buttons. No back/forward.
- Wordmark: Desktop elects GESTALT via the existing sidebar brand chain; browser fallback remains HARNESS.
- Update Control occupies the existing sidebar footer-action list on the same row as Settings (right when wide). It is not a Settings page.
- Updater protocol (from the prototype state machine): phases `disabled | idle | checking | available | downloading | preparing | downloaded | installing | error`. `autoDownload` is false. User must confirm download. On macOS, `preparing` waits until Squirrel stages the bundle; Install and restart is offered only after that. Ordinary quit does not install.
- Preload `contextBridge` exposes only updater and window verbs as `window.dshDesktop`. The page never imports Electron or Node.
- Development builds leave the updater in `disabled`. Packaged builds use electron-updater's GitHub provider against `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt`.
- First Desktop Bundle version is `0.1.0`, independent of npm `dsh`. App id is `com.gestalt.deepseek`. Display name is DeepSeek Gestalt.
- Release: `gestalt-v*` tag, manual `workflow_dispatch`, non-prerelease GitHub Release. macOS arm64 and x64 zip/dmg, notarized with 千机 team secrets. Windows per-user NSIS x64, unsigned, still updates.
- Packaged extraResources carry official Node and a production `dsh` snapshot. Dev uses workspace source plus a real Node (`DSH_NODE` / `npm_node_execpath`), never Electron's execPath.

### Updater status (prototype)

```ts
type UpdaterPhase =
  | "disabled" | "idle" | "checking" | "available"
  | "downloading" | "preparing" | "downloaded" | "installing" | "error"

interface UpdaterStatus {
  readonly state: UpdaterPhase
  readonly lastCheckedAt: number | null
  readonly newVersion?: string
  readonly downloadPercent?: number
  readonly errorMessage?: string
}
```

## Testing Decisions

A good test observes user-visible behavior at the Desktop Host boundary: the window URL, the presence or absence of Desktop chrome, updater phases after user actions, and Launch Directory cwd. It does not assert Electron internals, CSS class names, or Web Host implementation details.

Primary seam: **Desktop Host around the existing `dsh web:` announcement**. If the child prints a loopback URL and the window loads a page with `window.__DSH_BOOT__`, the wrap is correct. Secondary existing seams: sidebar brand chain, sidebar footer-action list, `window.dshDesktop` protocol. Do not add a new Host HTTP updater API.

Modules under test: Desktop Host spawn/URL discovery, Launch Directory, updater state machine, Desktop overlay chrome (badge, drag strip, Update Control), sidebar foot layout (Settings and footer actions on one row), and the guarantee that browser composition does not mount the overlay. A keyless runnable Web composition plus the Desktop overlay drives a replayed model turn and snapshots the Schedule catalog and call/result plus the final assistant reply, and asserts that the turn records no time-context message.

Prior art: CLI tests that wait for `dsh web: http://127.0.0.1:<port>`; sidebar apply/root/snapshot tests; client plugin tests that register into declared slots; keyless web snapshots when assembled GUI output changes.

## Out of Scope

- Reimplementing the Web Host inside Electron's Node ABI
- One Workspace per window
- Official `deepseek-ai/deepseek-harness` as the first update feed
- Windows Authenticode
- Linux packages
- Universal macOS fat binary
- Silent download or silent install
- New profile, second user-data home, or remembering window size
- Custom splash screen, back/forward, or replacing the native directory picker
- Changing default `dsh web` composition to probe for a Desktop bridge
- Operating-system, browser, email, SMS, or other external reminder delivery

## Further Notes

Glossary lives in the repo root context file. Desktop Host, Web Host, Desktop Bundle, Session Surface, Update Control, Personal Release Channel, Window Chrome, and Launch Directory are the terms to use. Do not call this DeepSeek Harness Desktop or treat Gestalt as 千机·Gestalt.
