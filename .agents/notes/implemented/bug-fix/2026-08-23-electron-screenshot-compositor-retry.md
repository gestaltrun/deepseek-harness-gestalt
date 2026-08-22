# Agent Note: Electron Screenshot Compositor Retry

Status: implemented

English | [中文](2026-08-23-electron-screenshot-compositor-retry.zh.md)

## Problem

An open and loaded Electron page can reject its first `webContents.capturePage` call with Chromium `UnknownVizError` before the first Viz compositor surface is available. The page remains usable, but the Browser Runtime reports the screenshot operation as unavailable.

## Decision

The Electron Browser Runtime recognizes only `UnknownVizError` as a transient compositor bootstrap failure. It waits for one renderer animation frame and retries `capturePage` once within the original abort signal and request deadline. A different error or a failed retry rejects the operation.

## Alternatives considered

**Retry every capture failure.** Rejected because it would delay or conceal non-transient renderer, device, and lifecycle failures.

**Show or focus the hidden page before capture.** Rejected because screenshots must not change presentation or focus ownership.

**Retry indefinitely.** Rejected because an unavailable compositor must remain bounded by the operation deadline and fail visibly.

## Consequences

The initial compositor race is absorbed without changing page visibility. Persistent and unrelated capture failures keep their existing error behavior.

## Testing

The fake Electron host verifies one successful retry for `UnknownVizError` and no retry for another capture error. The declared Electron runtime e2e exercises screenshot capture through a real Electron process.
