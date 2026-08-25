# Agent Note: Log Unexpected Remote Access Failures Without Request Authority

Status: implemented

English | [中文](2026-08-25-remote-access-unexpected-failure-logging.zh.md)

## Problem

Remote Access HTTP returned a generic `INTERNAL_ERROR` for unexpected service failures but recorded no server-side diagnostic. A real Desktop Mobile Access enable therefore returned HTTP 500 while both Platform instances remained healthy and bounded container logs could not distinguish a persistence defect from a transport or process failure. One-use `AccountError` results were also falling through the unexpected branch instead of retaining their stable code and authentication status.

## Decision

`HttpError`, `RemoteAccessError`, and `AccountError` keep their typed status, body, and optional retry behavior without an unexpected-failure log. Every other rejection writes one stderr diagnostic containing only the selected Remote Access operation, the fixed unexpected-failure marker, and a bounded cause taxonomy: persistence, transport, codec, contract, cleanup, dependency, or unexpected. Classification uses owned exception classes and allowlisted code families without recording the supplied code or any exception content. The public response remains the unchanged generic HTTP 500 body. The Relay client applies the same content-free classification to unknown connection failures before projecting its stable `REMOTE_OFFLINE` error.

## Alternatives considered

**Return the underlying exception to Desktop.** Rejected because persistence and deployment details are operator diagnostics and must not cross the public HTTP response.

**Log the complete request and Error object.** Rejected because the request carries bearer, proof, handshake, and sealed protocol authority, while an Error object can recursively expose implementation state beyond the actionable operation and message.

**Treat every failure as unexpected HTTP 500.** Rejected because Account replay, expiry, quota, capacity, and Remote Access state conflicts are stable application outcomes consumed by Desktop and Mobile retry policy.

## Consequences

Bounded Platform stderr identifies the failing operation and useful failure family while public clients retain a generic unexpected-failure response. Known security and capacity outcomes remain typed and do not duplicate logs. The operator must correlate a diagnostic by time and operation because the log intentionally omits request identity, authority material, exception messages, stacks, causes, and custom fields.

## Testing

The assembled HTTP route maps `PROOF_REPLAYED` to HTTP 401 without logging, retains Remote Access quota behavior, and injects a PostgreSQL-shaped Error containing a bearer secret. The stderr record contains only operation, the fixed marker, and `persistence`; serialized log arguments exclude the secret while the response remains generic HTTP 500. Relay lifecycle coverage injects a secret-bearing connection reset and observes only the fixed marker plus `transport`.
