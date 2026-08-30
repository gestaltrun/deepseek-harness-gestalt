# Agent Note: Keep Host composition when mobilecli is unresolvable

Status: implemented

English | [中文](2026-08-30-phone-runtime-unresolved-mobilecli.zh.md)

## Problem

Desktop and browser composition mount `phone-runtime` as an optional fleet provider. An Electron GUI process ships a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) and often an empty HOME npx cache, so `mobilecli` is frequently unresolvable even when a user has a global npm install. Throwing at plugin construction killed the whole Web Host before any URL announcement, so the Session Surface never loaded and the install guidance never reached the Phone tab.

## Decision

`PhoneDevices` still resolves the executable in the constructor, but an unresolvable binary no longer throws. The Service activates, skips the child process, and every public operation (`listDevices`, `boot`, `shutdown`, `io`, `startCapture`, `agentStatus`, `installAgent`) rejects with `PHONE_UNRESOLVED` carrying `mobilecliInstallGuidance`. Discovery order is `executablePath`, then `PATH`, then npm-global (`~/.npm-global/bin`, `~/.local/bin`, Windows `%APPDATA%\npm`), the npx cache (`~/.npm/_npx/*/node_modules/.bin`), and `npm_config_prefix`. An Electron-minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) also probes `/opt/homebrew/bin` and `/usr/local/bin`. `GET /phone/devices` answers 502 with `{ error: { code: 'PHONE_UNRESOLVED', message } }`. The picker and settings card render that as 「未找到 mobilecli」 plus `npm install -g mobilecli@latest`. The Desktop overlay-boot spec mounts the phone rows with `DSH_PHONE_MOBILECLI` pointing at a missing path, then asserts URL announcement, HTTP 200, and that 502 body.

This amends [the mobilecli provider note](../feature/2026-08-27-phone-runtime-mobilecli-provider.md): composition-time throw is reserved for a broken child after the binary resolved; a missing binary is an unavailable fleet, not a dead Host.

## Alternatives considered

**Keep composition-time throw.** Rejected: the overlay and the web-app roster share one process; a missing optional binary must not abort URL announcement.

**Leave the listing 502 as a generic `upstream` code.** Rejected: the tab's error arm needs the structured code and the install line, not `phone device listing failed with HTTP 502`.

**Search only `PATH`.** Rejected: Electron's minimal PATH hides a user-global npm install; the extra prefixes exist only for that GUI process.

## Consequences

A silently empty listing remains forbidden: the operator still sees install guidance, now on the Phone tab and settings card instead of a dead Host. A configured `executablePath` that does not name an executable file follows the same `PHONE_UNRESOLVED` arm. Other startup failures (child death before readiness) still reject plugin initialization. Desktop phone rows stay opt-in behind `DSH_PHONE_MOBILECLI`; the overlay-boot arm sets that env to a missing path so the unresolvable case is the one under test.
