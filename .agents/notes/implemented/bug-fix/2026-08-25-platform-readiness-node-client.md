# Agent Note: Platform Readiness Uses the Product HTTPS Client Family

Status: implemented

English | [中文](2026-08-25-platform-readiness-node-client.zh.md)

## Problem

The production ALB includes WAF. Its public route accepted the JavaScript and OpenSSL TLS clients used by the product, but reset the generic command-line HTTP client's TLS connection. Both replacement instances were healthy, yet the deploy gate classified the client-specific reset as an unavailable product origin and rolled back.

## Decision

The deploy job pins Node 24 and requests public `/readyz` with its native Fetch implementation. Redirects are errors, so the original production HTTPS route must respond directly. The existing gate still requires a successful response, the selected attachment storage, and both expected non-sensitive instance ids before rollback containers are removed.

## Alternatives considered

**Remove WAF from the ALB.** Rejected because a release probe must not weaken the production ingress security configuration.

**Ignore public readiness after loopback succeeds.** Rejected because DNS, certificate, listener, and backend-group failures remain release blockers.

**Accept one backend response.** Rejected because the operated service must prove that both non-sticky instances are reachable through the public origin.

## Consequences

The release gate exercises the same TLS client family as the shipped JavaScript applications while retaining the external routing and two-instance assertions. Node availability is explicit in the deploy job rather than inherited from a runner image.

## Testing

The executable shell harness stubs the Node request and covers unreachable, redirected, wrong-storage, one-backend, and two-backend success responses. A local HTTP server executes the real helper and covers success, HTTP failure, redirect, timeout, and connection refusal. The workflow contract requires Node 24 in deploy. The exact request helper also completes against the operated HTTPS health route while the generic command-line client reproduces the WAF reset.
