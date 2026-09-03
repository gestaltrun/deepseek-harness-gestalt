# Agent Note: Desktop GitHub login can be cancelled while authorizing or polling

Status: implemented

English | [中文](2026-09-02-desktop-cancel-github-login.zh.md)

## Problem

Desktop GitHub login has no local abort while Account status is `authorizing` or `polling`. The operator must wait for expiry, a failed poll, or a completed session, and a late poll can still persist a session after they have left the waiting panel.

## Decision

`DesktopAccountActions.cancelLogin()` is a no-op unless status is `authorizing` or `polling`, in which case it returns the same snapshot so a signed-in session stays signed-in. During those two statuses it aborts the in-flight `beginLogin` AbortSignal and cancels the scheduled poll immediately, then runs the generation bump, store re-read, persist, and publish as one `AccountLifecycleTransitions` owner. After dropping `pending` and `pendingPrivateKey`, the owner publishes signed-in when the re-read record still has a session, otherwise idle. `beginLogin` bumps the login generation and creates its AbortController inside the same owner so a concurrent begin cannot outrace cancel. Poll HTTP runs outside the owner so cancel can persist while a poll is in flight.

`PlatformAccountTransport.beginLogin` and `PlatformAccountHttpTransport.beginLogin` accept optional `{ signal?: AbortSignal }` and forward it to Fetch so cancel aborts the login-attempt POST. After a cancelled persist, `beginLogin` does not call `SystemBrowser.open`. `SystemBrowser.open` accepts optional `{ signal?: AbortSignal }`; Desktop `shell.openExternal` still settles after abort so cancel and dispose wait until that open is quiescent. A poll whose generation no longer matches does not write a session. `UnavailableDesktopAccountController.cancelLogin` returns the unavailable snapshot.

The preload exposes `accountCancelLogin` on `account:cancelLogin`. Settings AccountControl shows outline **取消登录 / Cancel sign-in** only on the waiting panel.

## Alternatives considered

**Leave login running until expiry or a failed poll.** Rejected: the waiting panel already owns the attempt, and a completed poll after the operator leaves must not create a session.

**Require `signal` on every `SystemBrowser.open`.** Rejected: Mobile Capacitor open has no abort adapter; the optional argument keeps that host compiling while Desktop waits for `shell.openExternal`.

**Clear pending without aborting HTTP or the browser open.** Rejected: an un-aborted POST or a post-cancel `openExternal` would still start GitHub authorization after idle is published.

## Consequences

Cancel is local to this Installation: Platform may still complete the GitHub attempt, but this Host never stores its session. Settings is not blocked on Host Account HTTP because `beginLogin` still returns the authorizing snapshot immediately; cancel is a separate IPC that waits for persist and a quiescent browser open.

## Testing

`apps/desktop/tests/platform-account.spec.ts` covers cancel during authorizing, persist, browser open, a late poll, an in-flight poll that completes after cancel, and signed-in no-op. The in-flight poll case requires the live snapshot to match the re-read store: idle with no session, or signed-in with that session. `packages/client/ui-desktop/tests/account-control.client.spec.tsx` shows the cancel button only in polling and authorizing and invokes `accountCancelLogin`. `packages/platform/platform-account-client/tests/installation.client.spec.ts` forwards the abort signal to Fetch.
