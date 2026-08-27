# Agent Note: Carry Desktop Platform HTTPS as bounded one-request Node workers

Status: implemented

English | [中文](2026-08-28-system-node-desktop-platform-http.zh.md)

## Problem

Moving Relay WSS to the bundled official Node runtime restored encrypted Mobile transport, but a fresh Desktop GitHub login still failed: Electron's `net.fetch` closed the operated Platform TLS connection through the same native system proxy. The failure also covered current-Installation refresh, Personal Pairing HTTP, and encrypted attachment consume. Official Node 24 simultaneously verified TLS and received HTTP 200 through that proxy.

## Decision

Electron continues to own system-proxy resolution, Platform Account and signing keys, Personal Pairing, Snow, Session operations, attachment authorization, and lifecycle. Each operated Platform HTTPS request forks a self-contained CommonJS worker under the bundled official Node executable. IPC supplies only that request's credential-free HTTPS URL, `GET`/`POST`/`DELETE` method, bounded headers and body, one credential-free proxy candidate or `DIRECT`, and the response ceiling. The worker disables compression negotiation, does not follow redirects, returns a bounded status/header/body response, and exits. Electron cancels and joins the worker before the request settles and retries only allowlisted connection failures in native proxy order.

Request authorization headers necessarily cross this process boundary for that one request. They are never placed in argv or environment, never logged, and disappear with the joined worker. Long-lived account records, signing keys, pairing keys, Snow state, Session data, and attachment keys remain in Electron. Both directions validate IPC tags and byte limits; the worker inherits only certificate and temporary-directory environment fields.

## Alternatives considered

- **Keep Electron `net.fetch` and retry** — rejected because consecutive fresh-login requests fail before HTTP while official Node succeeds at the same time.
- **Bypass the system proxy** — rejected because the operated host policy requires it and direct access is not available.
- **Move Account, pairing, or attachment authority into a persistent service** — rejected because it would duplicate lifecycle ownership and retain credentials across requests.
- **Disable TLS verification or follow redirects** — rejected because either could leak authorization or weaken Platform identity.

## Consequences

Desktop adds one short-lived child process per Platform HTTP candidate. Local regression coverage sends authorization-bearing JSON through a real TLS endpoint and HTTP CONNECT proxy, checks the response, and proves unsupported schemes, methods, bodies, and redirects fail before proxy resolution. Operated evidence proves a fresh GitHub login and two concurrently online phone pairings after the change. Attachment byte transfer remains a separate product acceptance action rather than being inferred from HTTP transport coverage.
