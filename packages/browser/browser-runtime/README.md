# @deepseek-ai/dsh-browser-runtime

English | [中文](README.zh.md)

Provider-neutral Service Definition for browser control. `ctx.browserRuntime` creates a temporary, named persistent, or shared Browser Profile hierarchy and addresses every operation with branded `BrowserProfileId`, `BrowserWorkspaceId`, `BrowserInstanceId`, and `BrowserTabId` values.

## Service API

`create` returns the initial open state at revision `0`. Omitting `attach` starts a new Workspace and browser instance. Attaching to a Workspace starts another instance; attaching to a browser instance starts another tab. A temporary request discards identity on close. A persistent request names one isolated Browser Profile and restores the same `persist:session-*` partition later. A shared request reuses the installation-wide `persist:session-*-shared` partition and does not take `BROWSER_PROFILE_BUSY`. `navigate`, `focus`, `input`, and `close` require the caller's last observed `expectedRevision`; Providers serialize operations and reject stale mutations with `BROWSER_REVISION_CONFLICT`. Synthetic Agent `input` requires a URL, text, or both and advances the revision. A second independent writer of the same named Profile rejects with `BROWSER_PROFILE_BUSY`; attaching to an already-open named Profile adds another instance or tab for that writer. `observe` and `screenshot` are read-only. `close` returns a terminal receipt that retains all four opaque identities. Open state also carries address-field `chrome` and `storage`. Storage isolation is the Chromium partition named on `chrome.partition`; storage fields stay empty unless a Provider observed them. Temporary chrome omits a label. Shared chrome names the reserved shared identity. Each method documents its applicable stable `BrowserRuntimeError` codes at the Service Definition.

`BrowserRuntimeState` carries open, `unavailable`, and closed states. An `unavailable` state is the truthful projection of Provider availability loss for an existing target: it retains the target and last revision, names the reason (`crashed`, `unhealthy`, or `reconnect-failed`), and flags an in-flight reconnect; it is not the terminal closed receipt. Operations on an unavailable target reject with `BROWSER_RUNTIME_UNAVAILABLE`; Providers that cannot interpret their backend's responses reject with `BROWSER_PROTOCOL`.

Providers publish committed states on `browser/runtime-state`. The notification is non-vetoing: each synchronous throw or asynchronous rejection is contained, later listeners still run, and asynchronous listener work is not awaited. The stateful Provider owns validation of that mutable relationship; this definition package owns only types, the service name, and the shared queue, identity, and notification helpers Providers call.

## Model Experience

Indirectly, through the dsh-tool-browser Consumer that renders Browser Runtime results.

#### KV Cache effect

This package alone adds no model tokens and changes no request prefix.

## Known Limitations and Deferred Work

- Dock chrome lives in [`dsh-client-ui-browser`](../../client/ui-browser/README.md). Session-local Workspace ownership lives in [`dsh-browser-workspace`](../browser-workspace/README.md).
