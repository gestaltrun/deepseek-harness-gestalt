# Agent Note: Phone quality-gate lint, coverage, and clone repair

Status: implemented

English | [中文](2026-09-05-phone-quality-gates.zh.md)

## Problem

Draft Phone CI failed three deterministic gates after #566: two `JSON.parse` `any` uses in `phone-stream` route tests, per-file coverage shortfalls in `phone-stream`, `ui-phone` invariant/registry, and `phone-environment`, and jscpd clones (Desktop overlay handset vs Phone tab icon; agent vs screenshot process-tree join; iOS upright vs rotated gesture projection; phone-stream session/agent/devices JSON-API admission).

## Decision

Route tests parse HTTP JSON as `unknown` and narrow object listings before member access. Coverage tests drive surviving post-#566 branches: nested/float Phone-tab lookup, Android H264 capture timeout and unexpected capture failures, and incomplete/malformed capture evidence on the io socket. The invariant companion's stub chrome stays inert (`component` returns null; `gate.subscribe` is a no-op subscription); the unused body factory is not invoked, so that path does not close the remaining `invariant.ts` coverage deficit. The 16-grid handset lives once as `IconPhoneOutline16` in ui-primitives. One-shot agent and screenshot commands share `awaitMobilecliTreeExit`, which assigns a deferred stop promise before invoking `tree.stop()` (including already-aborted budgets), assimilates that call's settlement, contains a synchronous `stop()` throw, joins child exit, and removes the abort listener on every path. A nested `budget.abort()` during `stop()` is not a second abort callback: the listener is `{ once: true }` and `AbortSignal.abort()` is idempotent. It does not stop a second time after exit. Callers keep halt classification and post-join wrapping. iOS coordinate IO projects taps and swipes through one `iosPortraitGesture` helper: upright taps stay taps, non-upright taps are a zero-length swipe at the same portrait point, and swipes remain swipes at both projected endpoints. Session, agent, and device-listing handlers share `admitTrustedJsonApi` for closing 503, untrusted 403, and method 405 before path or body work. Owner teardown sets `this.closing` before HTTP admission closes (`await fence` then `await http`), so `PhoneHttpTransactions.run` can still enter a handler after the fence; that handler must 503 and must not call backend. A public owner-plus-transactions lifecycle test pins `{ closing: true, handlerEntered: true }` with no backend call. Capture admission stays loopback-specific. Closing checks after foreign awaits remain. `cleanupDeadline` allocates its timeout Promise and timer before racing, then always clears that owned timer.

## Alternatives considered

**Leave `JSON.parse` untyped or disable the lint.** Rejected: the gate is the defect.

**Ignore remaining coverage lines or lower thresholds.** Rejected: the repository per-file 100% gate is the contract.

**Rewrite clones only enough to evade jscpd.** Rejected: the overlay and tab strip must share one glyph, both one-shot runners own the same abort-join, iOS upright and rotated gestures own one projector, and the three JSON-API handlers own one admission check.

## Consequences

Host and Desktop overlay render the same handset. Agent and screenshot still classify their own exits; only the join is shared. iOS upright taps and rotated zero-length swipes share one projector. Session, agent, and listing routes share one JSON-API admission; capture stays loopback-fenced. #566 semantic IO and capture-identity tests stay authoritative. #572 hidden presentation and native containment stay out of this repair.
