# Agent Note: Desktop Web Host `--no-open`

Status: implemented

English | [中文](2026-08-22-desktop-web-host-no-open.zh.md)

## Problem

`dsh web` opens the OS default browser after the Loader tree settles unless the invocation passes `--no-open`. Desktop Host already loads that loopback URL in its Electron window, so a default Web Host spawn duplicates the Session Surface in the system browser.

## Decision

Desktop Host spawn argv is `web --patch <overlay> --no-open --host 127.0.0.1 --port 0` for packaged and source launches. `--patch` stays ahead of app flags so the launcher consumes the overlay and the Web app receives `--no-open`. The Desktop overlay replaces the `web-runtime` row config with `openBrowser: false` while keeping `printUrl`, `surfaceContext`, and `trustedHosts`. Ordinary `dsh web` keeps `openBrowser: true` as decided in the [open-ready Web UI Agent Note](../feature/2026-08-12-open-ready-web-ui.md). The [Desktop Host Agent Note](../architecture/2026-08-16-deepseek-gestalt-desktop-host.md) records the spawn flags.

## Alternatives considered

**Change the `dsh web` default to `--no-open`.** Rejected because a local CLI launch still owns no window and still wants the OS browser; Desktop is the caller that already owns a window.

**Overlay `openBrowser: false` without `--no-open`.** Rejected as the sole control because unattended callers document `--no-open` as the invocation opt-out, and spawn argv is the packaged binary contract.

**`--no-open` without the overlay.** Rejected as the sole control because a Desktop Host binary that omits the flag still loads this overlay from extraResources, and the overlay replaces the complete `web-runtime` config so `ctx.webStartup.openBrowser` cannot reopen the OS browser.

## Consequences

A Desktop start prints the `dsh web:` URL line and does not print `dsh web: opening the default browser; pass --no-open to disable`. Browser-only `dsh web` is unchanged. Ordinary HTTP links from the Desktop window still use `shell.openExternal`.

## Testing

`apps/desktop/tests/runtime-paths.spec.ts` pins `--no-open` after `--patch` for packaged and source argv. `apps/desktop/tests/overlay-isolation.spec.ts` pins `openBrowser: false` on the Desktop overlay and the `!!js ctx.webStartup.openBrowser` default on the browser-only Web graph.
