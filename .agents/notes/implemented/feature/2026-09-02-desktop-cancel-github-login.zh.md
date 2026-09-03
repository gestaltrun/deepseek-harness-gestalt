# Agent Note: Desktop GitHub login can be cancelled while authorizing or polling

Status: implemented

[English](2026-09-02-desktop-cancel-github-login.md) | 中文

## Problem

Desktop GitHub 登录在 Account 状态为 `authorizing` 或 `polling` 时没有本地中止。操作者只能等到过期、轮询失败或会话完成；离开等待面板后，迟到的 poll 仍可能持久化会话。

## Decision

`DesktopAccountActions.cancelLogin()` 仅在状态为 `authorizing` 或 `polling` 时生效，否则返回同一快照，已登录会话保持已登录。这两种状态下它立即中止进行中的 `beginLogin` AbortSignal 并取消已调度 poll，再把 generation 递增、重读存储、持久化与发布作为同一次 `AccountLifecycleTransitions` owner 运行。丢弃 `pending` 与 `pendingPrivateKey` 后，若重读记录仍有 session 则发布 signed-in，否则发布 idle。`beginLogin` 在同一 owner 内递增 login generation 并创建 AbortController，避免并发 begin 抢在 cancel 之前。Poll HTTP 在 owner 外执行，因此取消可以在 poll 进行中完成持久化。

`PlatformAccountTransport.beginLogin` 与 `PlatformAccountHttpTransport.beginLogin` 接受可选 `{ signal?: AbortSignal }` 并转给 Fetch，使取消能中止 login-attempt POST。取消 persist 之后，`beginLogin` 不再调用 `SystemBrowser.open`。`SystemBrowser.open` 接受可选 `{ signal?: AbortSignal }`；Desktop 的 `shell.openExternal` 在 abort 后仍会 settle，因此 cancel 与 dispose 等到该 open 静止。generation 已不匹配的 poll 不会写入会话。`UnavailableDesktopAccountController.cancelLogin` 返回 unavailable 快照。

preload 在 `account:cancelLogin` 上暴露 `accountCancelLogin`。Settings AccountControl 仅在等待面板显示描边按钮 **取消登录 / Cancel sign-in**。

## Alternatives considered

**让登录一直跑到过期或 poll 失败。** 否决：等待面板已经拥有这次尝试，操作者离开后完成的 poll 不得创建会话。

**要求每次 `SystemBrowser.open` 都带 `signal`。** 否决：Mobile Capacitor open 没有 abort 适配器；可选参数让该 host 继续编译，同时 Desktop 等待 `shell.openExternal`。

**只清 pending，不中止 HTTP 或浏览器打开。** 否决：未中止的 POST 或取消后的 `openExternal` 仍会在发布 idle 之后启动 GitHub 授权。

## Consequences

取消只作用于本 Installation：Platform 仍可能完成 GitHub 尝试，但本 Host 不会存储其会话。Settings 不会被 Host Account HTTP 堵住，因为 `beginLogin` 仍立即返回 authorizing 快照；取消是另一条 IPC，会等待 persist 以及静止的浏览器打开。

## Testing

`apps/desktop/tests/platform-account.spec.ts` 覆盖 authorizing、persist、打开浏览器、迟到 poll、进行中 poll 在取消后完成，以及已登录 no-op。进行中 poll 要求现场快照与重读存储一致：无 session 则为 idle，有 session 则为 signed-in。`packages/client/ui-desktop/tests/account-control.client.spec.tsx` 仅在 polling 与 authorizing 显示取消按钮并调用 `accountCancelLogin`。`packages/platform/platform-account-client/tests/installation.client.spec.ts` 把 abort signal 转给 Fetch。
