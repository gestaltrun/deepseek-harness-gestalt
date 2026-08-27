# `@deepseek-ai/dsh-project-membership-http`

English | [中文](README.zh.md)

HTTP Consumer for `ctx.projectMembership`. It registers the project-registry creation route, the roster read, invitation issuance, the body-discriminated `accept-with-link`/`decline` decision, retraction, the member role, function-tag, and removal routes, and the per-installation presence heartbeat. Every route is a thin adapter onto one membership operation, which owns each role gate; the Consumer copies no membership state. Responses disable caching; errors use stable JSON envelopes that carry the domain code — membership `INVALID_*` answers 400, `ROLE_REQUIRED` and `NOT_A_MEMBER` answer 403, `*_NOT_FOUND` answers 404, `DUPLICATE_INVITEE`, `PROJECT_NAME_TAKEN`, `INVITATION_NOT_PENDING`, and `LAST_OWNER` answer 409, revoked Account sessions answer 401, and Account `QUOTA`/`PLATFORM_CAPACITY` answer 429 with a `Retry-After` header. Its required non-empty `origins` Config must include the Account provider's selected validated environment origin; request bodies are capped at 64 KiB and parsed through the `@deepseek-ai/dsh-host-webserver` JSON helpers.

Every route resolves the acting account from an existing Account session: a bearer access token plus the `x-gestalt-proof-*` installation proof headers, verified through `ctx.platformAccount.current`, with the heartbeat route resolving the installation through `currentInstallation`. The parameterized routes register as the `/v1/projects` prefix owners and answer 404 for unmatched subpaths.

Presence is heartbeat-registered and liveness-only: an authenticated installation calls `POST /v1/projects/presence/heartbeat` on the `presenceHeartbeatIntervalMs` cadence (default 60 seconds), each beat stays live for `presenceTtlMs` (default 90 seconds), and expiry is the only route to offline — a member is `online` while any of their installations holds a live heartbeat, and roster reads attach that `presence` verdict to every member. There is no manual state and no idle inference.

Heartbeat entries live in a process-local TTL map behind the reserved `PresenceStore` adapter; a shared store that keeps presence consistent across Platform instances is deferred deployment work, not a service change.

## Model Experience

None, as installation UI and product clients consume these routes.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- TLS termination, rate limiting, and deployment observability belong to the Platform edge.
- The Consumer assumes the Platform composition mounted one authoritative membership provider beside the Account service.
- Presence entries are process-local; a multi-instance deployment needs a shared TTL store (for example Redis) implementing `PresenceStore` before presence is consistent across Platform instances.
