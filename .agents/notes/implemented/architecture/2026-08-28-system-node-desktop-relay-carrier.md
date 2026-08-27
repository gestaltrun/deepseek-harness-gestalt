# Agent Note: Carry Desktop Relay WSS in the bundled official Node runtime

Status: implemented

English | [中文](2026-08-28-system-node-desktop-relay-carrier.zh.md)

## Problem

The operated Relay WSS endpoint completes through the current system HTTP CONNECT proxy under the bundled official Node runtime, but Electron 41 and 44 reset the same TLS connection before WebSocket negotiation. Proxy resolution, explicit SNI, HTTP/1.1 ALPN, TLS 1.2, direct connection, and an Electron upgrade do not remove that process-specific failure. Keeping WSS inside Electron therefore leaves authenticated Mobile devices projected as offline even while Desktop publishes their online presence.

## Decision

Electron continues to own Platform Account, Personal Pairing, Snow keys and codecs, Companion operations, lifecycle, and native system-proxy resolution. For each resolved candidate it forks a bundled CommonJS helper under the same official Node executable already shipped for Web Host, then sends only the credential-free Relay WSS URL, an optional credential-free HTTP(S) proxy URL, and encrypted Relay frame bytes over advanced-serialization IPC. `DIRECT` is represented by the absent proxy URL. The helper owns one `ws` connection and returns only binary frames plus content-free lifecycle or failure metadata.

The helper inherits only certificate and temporary-directory environment fields. Both IPC directions validate message tags and the Relay wire-byte ceiling. Electron retains the bounded inbound queue and allowlisted candidate fallback policy. Acquisition cancellation terminates and joins the child; normal socket close requests a WebSocket close, escalates to termination after one second, and joins the child before Relay teardown completes. The packaged application installs the self-contained CommonJS helper as an extra resource because the `ws` dependency still uses CommonJS runtime imports and the helper must not depend on the packaged application's module graph.

## Alternatives considered

- **Disable TLS verification or broaden accepted certificates** — rejected because the failure occurs before certificate policy can safely explain it, and weakening Relay authentication is not an acceptable transport workaround.
- **Bypass the system proxy** — rejected because direct Electron and Node attempts cannot reach the operated endpoint from this environment, while the configured proxy is an explicit host policy.
- **Upgrade Electron only** — rejected because Electron 44 reproduces the same reset.
- **Move Snow or Companion protocol authority into the helper** — rejected because it would expose pairing credentials and application state to another process and duplicate the existing Desktop lifecycle owner. The helper remains a byte carrier.

## Consequences

Desktop gains one short-lived child process per Relay transport candidate. The process boundary avoids Electron's failing TLS runtime while preserving Electron's native proxy ordering and all authenticated protocol authority. Tests cover real WSS binary exchange through a local HTTP CONNECT proxy, bounded IPC, joined teardown, runtime-path selection, proxy-candidate projection, bundle self-containment, and packaged-resource placement. Failures expose only stable stage, name, and code metadata; endpoint, proxy, frame, and credential contents never enter diagnostics.
