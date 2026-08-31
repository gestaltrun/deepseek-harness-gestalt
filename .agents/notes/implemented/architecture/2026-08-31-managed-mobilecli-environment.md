# Agent Note: Managed mobilecli environment

Status: implemented

English | [中文](2026-08-31-managed-mobilecli-environment.zh.md)

## Problem

Desktop could compose phone capabilities only when an operator supplied a mobilecli executable. A clean installation therefore exposed a dead-end missing state, and a later installation required remounting lifecycle owners or restarting Desktop. Downloading an executable also introduces supply-chain, filesystem, and licensing obligations that do not belong in the fleet Service.

## Decision

`phone-environment` owns the complete runtime snapshot, trusted preparation, and runtime selection in explicit override, managed current, then system order. Desktop always composes the environment, stable fleet, stream, and tool Consumer. The fleet starts deferred and the environment activates a selected executable in place only while the durable phone gate is enabled.

Managed preparation accepts only the six fixed mobile-next/mobilecli 1.0.5 GitHub Release assets recorded with exact URL, byte length, SHA-256 digest, host tuple, and executable name. It follows only the GitHub release-asset host, writes an owner-only staging directory, checks streamed length and digest, accepts exactly one root zip entry, probes the executable version, and atomically replaces a relative `current.json` pointer. Cancellation or failure removes staging and preserves the prior current generation. The operation never modifies global npm state or `PATH`.

The browser reads a full snapshot and invokes prepare, cancel, or refresh through Host routes protected by the shared same-origin trust fence. Android and iOS platform rows are separate extensible states. A non-macOS iOS row reports unsupported and has no executable action.

mobilecli is licensed under FSL-1.1 with an Apache-2.0 future license. Direct runtime download from the upstream release is not bundling or redistribution by this repository, but it is not legal clearance. Desktop release remains blocked until counsel or the upstream licensor confirms that the intended product use is permitted.

## Alternatives considered

**Bundle or vendor mobilecli.** Rejected because it expands redistribution and release-license risk and prevents an upstream-authentic download.

**Install mobilecli globally with npm.** Rejected because product preparation must not require administrator access, mutate the user's shell environment, or depend on a user-managed global toolchain.

**Restart Desktop after preparation.** Rejected because the stable fleet already owns generation replacement and can stop old IO and activate the verified executable without replacing Consumer identities.

## Consequences

A clean Desktop can reach a managed runtime from the Phone Devices settings page without a manual install or restart. Enabled, disabled, cancelled, replaced, and torn-down states share the same child and IO ownership. Platform-specific SDK and simulator preparation remains in the Android and iOS environment packages. The FSL-1.1 product-use decision remains an explicit release blocker even when every technical gate passes.
