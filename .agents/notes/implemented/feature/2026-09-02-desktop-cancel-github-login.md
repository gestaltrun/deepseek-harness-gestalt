# Agent Note: Desktop GitHub login can be cancelled while authorizing or polling

Status: implemented

English | [中文](2026-09-02-desktop-cancel-github-login.zh.md)

## Problem

Desktop GitHub login has no local abort while Account status is `authorizing` or `polling`. The operator must wait for expiry, a failed poll, or a completed session, and a late poll can still persist a session after they have left the waiting panel.

## Decision

`DesktopAccountActions.cancelLogin()` is a no-op unless status is `authorizing` or `polling`, in which case it returns the same snapshot so a signed-in session stays signed-in. During those two statuses it increments the login generation, aborts the in-flight `beginLogin` AbortSignal, cancels the scheduled poll, waits for the current `AccountLifecycleTransitions` owner to drain, drops `pending` and `pendingPrivateKey`, persists, and publishes `{ status: 'idle', privacyAccepted }`.

`PlatformAccountTransport.beginLogin` and `PlatformAccountHttpTransport.beginLogin` accept optional `{ signal?: AbortSignal }` and forward it to Fetch so cancel aborts the login-attempt POST. After a cancelled persist, `beginLogin` does not call `SystemBrowser.open`. `SystemBrowser.open` accepts optional `{ signal?: AbortSignal }`; Desktop `shell.openExternal` still settles after abort so cancel and dispose wait until that open is quiescent. A poll whose generation no longer matches does not write a session. `UnavailableDesktopAccountController.cancelLogin` returns the unavailable snapshot.

The preload exposes `accountCancelLogin` on `account:cancelLogin`. Settings AccountControl shows outline **取消登录 / Cancel sign-in** only on the waiting panel.

## Alternatives considered

**Leave login running until expiry or a failed poll.** Rejected: the waiting panel already owns the attempt, and a completed poll after the operator leaves must not create a session.

**Require `signal` on every `SystemBrowser.open`.** Rejected: Mobile Capacitor open has no abort adapter; the optional argument keeps that host compiling while Desktop waits for `shell.openExternal`.

**Clear pending without aborting HTTP or the browser open.** Rejected: an un-aborted POST or a post-cancel `openExternal` would still start GitHub authorization after idle is published.

## Consequences

Cancel is local to this Installation: Platform may still complete the GitHub attempt, but this Host never stores its session. Settings is not blocked on Host Account HTTP because `beginLogin` still returns the authorizing snapshot immediately; cancel is a separate IPC that waits for persist and a quiescent browser open.

## Testing

`apps/desktop/tests/platform-account.spec.ts` covers cancel during authorizing, persist, browser open, a late poll, and signed-in no-op. `packages/client/ui-desktop/tests/account-control.client.spec.tsx` shows the cancel button only in polling and authorizing and invokes `accountCancelLogin`. `packages/platform/platform-account-client/tests/installation.client.spec.ts` forwards the abort signal to Fetch.
