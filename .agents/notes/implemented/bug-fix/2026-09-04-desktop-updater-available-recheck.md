# Agent Note: Desktop updater rechecks while an update is offered

Status: implemented

English | [中文](2026-09-04-desktop-updater-available-recheck.zh.md)

## Problem

The Update Control shows `下载 {version}` from the last `update-available` payload. After that phase, `startAutoUpdater` skipped the 15-minute GitHub feed check so a later `latest.yml` version never replaced the offered one. Restarting Desktop was the only way to see a newer published bundle.

## Decision

`available` still rechecks the GitHub feed on the same interval and on `checkNow`. The control stays in `available` during that probe: `checking-for-update` does not hide it, a later `update-available` replaces `newVersion`, and `update-not-available` returns to `idle`. A recheck error while `available` keeps the offered version instead of switching to `error`. Download, prepare, downloaded, and installing still skip the interval so an in-flight installer is not replaced.

## Alternatives considered

**Leave `available` until the user downloads or restarts.** Rejected because a later GitHub Release then stays invisible for the whole Desktop process.

**Switch to `checking` on every recheck.** Rejected because the control disappears during the probe and the user loses the download action.

**Treat a recheck failure as `error`.** Rejected because a transient feed failure would hide a still-valid offered installer.

## Consequences

The offered version tracks the current GitHub latest while the user has not started download. Tests pin version replacement, a silent recheck error, and an in-flight recheck that cannot interrupt download.

## Testing

`apps/desktop/tests/updater.spec.ts` drives `available` → newer `update-available`, a rejected silent recheck, and a recheck that races `download()`.
