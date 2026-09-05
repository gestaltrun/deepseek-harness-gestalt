# Agent Note: Web Host post-ready exit provenance

Status: implemented

English | [中文](2026-09-05-web-host-exit-provenance.zh.md)

## Problem

Desktop observes Web Host death only as `Promise<void>`. The `exit` listener that names `code` and `signal` returns after the URL announcement, so a Host that dies while serving is indistinguishable from a requested stop. `planHostExit` can still respawn or show an error page, but operators cannot tell whether Desktop asked the child to stop.

This record is wait(2) facts for the **direct Node child**. It does not prove renderer, GPU, or mobilecli descendants are gone. Killing recorded PIDs after Host death is not containment: PID reuse and escaped descendants remain unresolved.

## Decision

`RunningWebHost.exited` resolves to a frozen `WebHostExit`: `pid`, `code`, `signal`, and `requestedStop`. Child stdout/stderr is **not** on that record. There is no post-ready raw log retention.

Pre-ready timeout and early-exit errors redact **one complete in-memory `startupBuffer`**, then truncate. That buffer is **unbounded until the URL is announced**, then cleared. Startup buffering is unchanged from that preexisting contract; this slice does not claim bounded Host-lifetime storage. There is no streaming collector and no mid-line `pending` drop.

`requestedStop` is a closed union: `none` (unsolicited), `stop` (`RunningWebHost.stop`), `abort` (command AbortSignal). The first cause wins. `stop()` and abort share one memoized request/join; the Promise is published before `kill`. Kill failure rejects that Promise. A post-ready abort with no `stop()` waiter does not silently drop a kill failure: Desktop emits `DSH_WEB_HOST_ABORT_STOP_FAILED` with a bounded, redacted `Error.name`/`message` only. Desktop `observeHostExit` uses `observeWebHostExit`: a throwing `smokeLog` (`appendFileSync`) cannot skip `onHostExit`. Recovery is scheduled with `Promise.resolve().then(onExit)` so a synchronous throw cannot reject `exited`. The observer contains that failure and emits `DSH_WEB_HOST_EXIT_RECOVERY_FAILED` with a fixed message, not the recovery `Error` text. `formatWebHostExit` is written only when `DSH_DESKTOP_SMOKE_FILE` is set. That is not a product-readable cause. `planHostExit` is unchanged.

Node fixtures cover post-ready `_exit(1)`, requested `stop`, and post-ready abort. No Electron and no device launch.

## Alternatives considered

**Keep `Promise<void>` and read `child.exitCode` later.** Rejected because consumers can attach after `exit`, and `killed` means a signal was sent, not that the process exited.

**Treat PID-list SIGKILL as native containment.** Rejected because identifier reuse and descendants started after the snapshot are not owned. That work stays Issue #574 and is not this slice.

**Change respawn policy from the new record.** Rejected because provenance is diagnostic; recovery remains window-alive plus one respawn.

**Ship a streaming collector that splits flush and pending, then redacts each half.** Rejected. Concatenating those halves can reassemble a known secret. `WebHostExit` omits the child log. Pre-ready errors keep one complete startup buffer.

## Consequences

Operators can tell unsolicited Host death from `stop` and abort without changing respawn. The exit record has **no child log**: a live Host that dies while printing credentials is not reconstructed from `WebHostExit`. Native process-tree cleanup is **not** in this slice; recorded PIDs remain wait(2) facts only. Pre-ready `startupBuffer` stays **unbounded until the URL is announced**, then discarded — inherited, not a new bound. `formatWebHostExit` is smoke-file only; recovery does not depend on it.
