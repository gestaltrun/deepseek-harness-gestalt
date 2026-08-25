# Agent Note: Log Unexpected Remote Access Failures Without Request Authority

Status: implemented

English | [中文](2026-08-25-remote-access-unexpected-failure-logging.zh.md)

## Problem

Remote Access HTTP returned a generic `INTERNAL_ERROR` for unexpected service failures but recorded no server-side diagnostic. A real Desktop Mobile Access enable therefore returned HTTP 500 while both Platform instances remained healthy and bounded container logs could not distinguish a persistence defect from a transport or process failure. One-use `AccountError` results were also falling through the unexpected branch instead of retaining their stable code and authentication status.

## Decision

`HttpError`, `RemoteAccessError`, and `AccountError` keep their typed status, body, and optional retry behavior without an unexpected-failure log. Every other rejection writes one stderr diagnostic containing only the selected Remote Access operation plus Error name and message, then returns the unchanged generic HTTP 500 body. The diagnostic never includes authorization headers, proof fields, request bodies, pairing messages, sealed Relay authority, or attachment ciphertext; non-Error rejections receive a fixed description rather than their rejected value.

## Alternatives considered

**Return the underlying exception to Desktop.** Rejected because persistence and deployment details are operator diagnostics and must not cross the public HTTP response.

**Log the complete request and Error object.** Rejected because the request carries bearer, proof, handshake, and sealed protocol authority, while an Error object can recursively expose implementation state beyond the actionable operation and message.

**Treat every failure as unexpected HTTP 500.** Rejected because Account replay, expiry, quota, capacity, and Remote Access state conflicts are stable application outcomes consumed by Desktop and Mobile retry policy.

## Consequences

Bounded Platform stderr identifies the failing operation and concrete exception while public clients retain a generic unexpected-failure response. Known security and capacity outcomes remain typed and do not duplicate logs. The operator must correlate a diagnostic by time and operation because the log intentionally omits request identity and authority material.

## Testing

The assembled HTTP route maps `PROOF_REPLAYED` to HTTP 401 without logging, retains Remote Access quota behavior, and injects an unexpected Error whose stderr record contains only operation, Error name, and message while the response remains generic HTTP 500.
