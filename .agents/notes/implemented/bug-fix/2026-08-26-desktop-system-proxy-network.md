# Agent Note: Use Electron System Proxy for Desktop Platform Traffic

Status: implemented

English | [中文](2026-08-26-desktop-system-proxy-network.zh.md)

## Problem

Desktop Platform Account and Remote Access HTTP used Node global Fetch, and Relay WSS used a direct Node socket. Those paths ignored the operating-system proxy selected by Electron. In a valid macOS system-proxy configuration, the packaged Desktop therefore showed `fetch failed` before GitHub login even though the same production Platform was healthy through the configured proxy.

## Decision

Desktop-owned Platform Account, Remote Access, and attachment HTTP use Electron `net.fetch`, which follows the current Electron session network policy. Each fresh Relay WSS acquisition asks `Session.resolveProxy` for the operated WSS URL, bounded by the attachment deadline and Relay cancellation. The ordered result retains every `PROXY`, `HTTPS`, and `DIRECT` candidate. Connection-refused, reset, unreachable, broken-pipe, and timeout failures advance to the next candidate; certificate, protocol, and other failures stop without bypassing the selected route. Unsupported proxy directives fail visibly instead of silently bypassing policy.

## Alternatives considered

**Read `HTTP_PROXY` and `HTTPS_PROXY`.** Rejected because packaged GUI applications do not reliably inherit shell variables and those values can disagree with the active Electron session.

**Require users to disable the proxy.** Rejected because it makes the operated product depend on a local networking workaround and does not match Chromium behavior in the same application.

## Consequences

Desktop HTTP and Relay WSS share the operating-system routing decision without embedding a proxy address or credential in the product artifact. Mobile remains on its native WebView networking stack. The WSS adapter still verifies the Platform certificate after CONNECT.

## Testing

Unit coverage proves Electron Fetch forwarding, ordered `DIRECT`, HTTP and HTTPS candidates, unsupported-directive rejection, DNS and connection fallback, bounded blackhole fallback, certificate failure without fallback, pending-resolution cancellation, and WSS agent injection. The packaged-main test keeps the CommonJS proxy agent external to the ESM bundle. Operated acceptance uses the packaged Desktop with the active macOS system proxy and the production Platform origin.
