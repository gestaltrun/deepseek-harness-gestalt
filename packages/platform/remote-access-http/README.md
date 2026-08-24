# Remote Access HTTP

English | [中文](README.zh.md)

HTTP and WSS Consumers for the public Remote Access services. One fixed HTTP route accepts current-Installation Account proof headers, validates operation input, and delegates only through `ctx.remoteAccess`. Pairing Challenge requests pass the TCP peer address to the per-IP hourly quota. `QUOTA` and `PLATFORM_CAPACITY` map to HTTP 429 with JSON `retryAfter` and a `Retry-After` header. Blob admission operations (`admit-blob`, `release-blob`) enforce the declared-size quotas. The exact WSS path accepts only Relay Transport frames and delegates authenticated attachments through `ctx.remoteRelay`. JSON bodies and error envelopes go through the `@deepseek-ai/dsh-host-webserver` helpers with Remote Access-owned codes and copy.

The Consumer reads no Account database fields and grants no authority itself. The Remote Access provider authenticates the Account and Installation role through the Platform Account public service before any pairing lifecycle mutation.

The WSS Consumer requires an endpoint-owned challenge request and signed attach proof before any Relay ciphertext, applies explicit pending-challenge and attach deadlines plus the protocol message-byte ceiling, disables compression, serializes frames, and sends ready only after authorization and directory registration complete. It tears down the Relay attachment with the socket and returns only content-free stable transport errors. The assembled test boots two independent Loader-owned WebServer/HTTP compositions, reaches both published WSS upgrade handlers through a non-sticky TLS endpoint, and runs two endpoint-owned Snow pairings through independent revocation. Its localhost certificate and memory adapters are deterministic test inputs; TLS termination and operated infrastructure remain deployment responsibilities.

## Model Experience

None, as the HTTP Consumer handles pairing state outside model requests.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- The WSS Consumer forwards opaque Relay ciphertext only; it never accepts Host requests or Companion plaintext.
- Deployment TLS, edge limits, and audit policy remain Platform composition responsibilities.
