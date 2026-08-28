# dsh-request-trust

English | [中文](README.zh.md)

The zero-dependency browser-trust fence shared by every local HTTP route a browser can reach: the `/api` carrier (`@deepseek-ai/dsh-client-connection`) and the phone-stream routes (`@deepseek-ai/dsh-phone-stream`). One judgment for the Host, Origin, and Fetch-Metadata rules, read from either HTTP representation — Node `IncomingMessage` headers and Fetch `Headers` — so per-route copies cannot drift.

## What the fence decides

`isTrustedApiRequest(request, trustedHosts)` grants a request only when the `Host` authority is ours and any attached browser markers are same-origin:

- **Host fence** (DNS-rebinding defense, applied to every request): `Host` must be a loopback authority or match a `trustedHosts` entry — exact on `host:port` entries, any port on port-less entries, both sides compared through WHATWG normalization. There is deliberately no shortcut for unmarked requests: over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to image and navigation reads, so an unmarked request may still be a rebound browser read with a readable response, and `Host` is the one header rebinding cannot forge.
- **Cross-site fence**: an explicit `sec-fetch-site: cross-site` marker is refused regardless of `Origin`.
- **Origin fence**: an attached `Origin` must equal the `Host` authority through the same normalization; absent `Origin` is fine, and the literal `null` (sandboxed iframes, `file:` pages) is refused.

`isLoopbackApiRequest(request)` is the loopback-only extra check for routes that serve signed URLs to an already trusted page (phone capture streams): a trusted LAN `Host` is not enough.

`isBareAuthority(entry)` is the `trustedHosts` config predicate: an entry must be a bare canonical `host[:port]` authority that survives WHATWG parsing unchanged (case aside). Loaders assert it at plugin load, because parsing would otherwise quietly authorize the hostname inside `harness.internal/path` or broaden a dangling-colon or zero-padded port to an any-port grant.

The fence is a confused-deputy defense, not an authentication layer; reachability stays with the webserver binding and authentication for genuinely remote deployments stays deferred work of the consuming carrier. Decision record: [the api browser-trust boundary Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md).
