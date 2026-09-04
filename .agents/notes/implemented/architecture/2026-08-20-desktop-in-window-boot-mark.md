# Agent Note: Desktop in-window boot mark

Status: implemented

English | [中文](2026-08-20-desktop-in-window-boot-mark.zh.md)

## Problem

Desktop Host shows a BrowserWindow before the Web Host prints a loopback URL. Account restore and Host spawn used to run in series on that blank window. The web shell loading page can paint only after `loadURL`, so the long wait is blank and the plugin-loading spinner flashes for a frame once the Host is already up.

## Decision

Desktop Host owns the visible cold-start mark. `createWindow()` paints a local `boot.html` overlay (`WebContentsView`) on the same window, with `-webkit-app-region: drag` and `prefers-color-scheme` / `prefers-reduced-motion`. After `loadURL`, `revealHost` polls `globalThis.__DSH_SHELL_READY__ === true`, with `[data-desktop-chrome]` and the fail-loud plugin page as fallbacks so a stale frontend cannot pin the overlay. `AppWebEntry` sets that flag after the settled Session Surface mounts or the fail-loud plugin page paints, then the overlay is removed. Browser `dsh web` still uses the shell loading page. There is no second splash window. `joinHostAfter` remains a testable overlap helper; cold start currently restores Account, Personal Pairing, and sub2api before Host spawn because the Host start timeout is taken from the sub2api snapshot.

## Alternatives considered

**Keep the SPEC.md blank-window cold start.** That avoided a separate splash window, but the wait is Host spawn, which the web loading page cannot cover.

**Navigate the main `webContents` from `boot.html` to the Host URL.** Navigation unloads the mark before the Session Surface paints, so the blank-or-flash gap remains.

**Await Personal Pairing before `loadURL`.** A signed-in Remote Access load would stall the Host URL even though the Session Surface does not need pairing on first paint.

**Put the boot mark only in `index.html` / AppWebEntry.** That still starts after Host spawn, which is the slow step.

## Consequences

Cold start shows GESTALT from the first frame until the real UI (or fail-loud page) is on screen. Host spawn overlaps Account start. A Host-side error page replaces the mark because `showError` runs before overlay dispose. The web loading page remains the browser and fail-loud gate; Desktop users do not see "Loading plugins…" during a successful boot.

## Testing

`apps/desktop/tests/boot-session.spec.ts` pins overlapped Host start, ready-flag polling, and that `boot.html` is self-contained and packaged. `packages/client/web/tests/boot.client.spec.ts` pins `__DSH_SHELL_READY__` after settled mount and fail-loud commits. Desktop smoke still requires the Session Surface evidence after `loadURL`.
