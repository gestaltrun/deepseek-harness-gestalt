# Agent Note: Capacitor Tuple Origins at Platform HTTP Routes

Status: implemented

English | [中文](2026-08-25-capacitor-platform-cors-origins.zh.md)

## Problem

Bundled Android and iOS applications call Platform from `https://localhost` and `capacitor://localhost`, while Platform Account, Personal Pairing, and encrypted attachment routes admitted only the public Platform origin. Browser preflight therefore rejected the first native Account request before GitHub authorization and would reject the later pairing and attachment routes for the same reason.

Custom-scheme origins require exact tuple handling. Standard URL origin normalization turns `capacitor://localhost` into the opaque value `null`; allowing that value would also admit unrelated opaque documents.

## Decision

Every Platform HTTP Consumer receives a non-empty explicit `origins` list. `CorsOriginPolicy` validates and deduplicates complete serialized origins at plugin load, matches the raw request Origin against that list, and returns the configured value for `Access-Control-Allow-Origin`. It rejects paths, credentials, query strings, fragments, malformed values, and the opaque `null` value.

The operated Platform composition admits exactly its public HTTPS origin, Android's `https://localhost`, and iOS's `capacitor://localhost`. The two local origins are fixed by the shipped Capacitor container rather than supplied by a request or Pairing Challenge. This decision refines the Account HTTP binding recorded in [GitHub Platform Account and installation sessions](../feature/2026-08-17-platform-account-installation-sessions.md).

## Alternatives considered

**Allow every origin with `*`.** Rejected because Account proofs, Personal Pairing operations, and attachment capabilities remain security-sensitive even when other authorization checks apply.

**Allow `Origin: null` for iOS.** Rejected because `null` represents many opaque documents and does not preserve the configured Capacitor tuple origin.

**Proxy native requests through a new Capacitor plugin.** Rejected because native HTTP would duplicate request, proof, error, and lifecycle behavior already owned by the shared TypeScript clients.

**Change the iOS local scheme to HTTPS.** Rejected because WKWebView reserves HTTP and HTTPS for network loading; Capacitor serves bundled iOS assets through a custom scheme.

## Consequences

Bundled Mobile installations can reach Account, Personal Pairing, and encrypted attachment HTTP routes through the operated ALB/WAF endpoint. Adding another shipped container origin requires an explicit composition change and exact-origin tests; arbitrary localhost ports, suffix matches, request-provided origins, and opaque origins remain unavailable.

The shared policy keeps custom-scheme parsing identical across all three Consumers. Package tests exercise each public HTTP route, and the operated composition test exercises both native origins across the assembled route set while proving `Origin: null` remains denied.
