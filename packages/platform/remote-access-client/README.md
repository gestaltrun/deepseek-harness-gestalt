# Remote Access client

English | [中文](README.zh.md)

Authenticated Desktop and Mobile HTTP transport for the public Remote Access service. It keeps the default Fetch implementation bound to the global so browsers can call it, forwards one current-Installation Account proof per operation, and validates every JSON response before exposing branded Personal Pairing identifiers. `QUOTA` and `PLATFORM_CAPACITY` responses preserve integer `retryAfter` seconds on the thrown `RemoteAccessError`.

The client does not implement a handshake or store pairing keys. Product controllers supply signed-in Account authorization and use the independently reviewed server-side handshake provider selected by the Platform deployment. After confirmation, the Mobile pairing controller opens its sealed endpoint-specific Relay authority through the crypto adapter and configures `MobileRelayEndpointLifecycle`; the lifecycle can send on the live attachment, and `unpair()` calls `configure(undefined)` so the lifecycle has no authority. The controller never receives the Desktop credential.

`RemoteRelayEndpointController` owns one outbound Mobile or Desktop WSS lifecycle through the deployment's single non-sticky Platform endpoint. Every physical connection obtains a fresh attachment id and authenticates with the current opaque route id plus rotatable high-entropy credential. The controller waits for the matching Platform ready acknowledgement before resynchronizing, cancels credential and DNS/TLS acquisition during stop, and observes socket plus heartbeat teardown through all-settled cleanup. Socket loss starts a new connection after the validated retry delay; Desktop emits its authoritative encrypted resynchronization after every attachment. Sends fail with `REMOTE_OFFLINE` while disconnected and are never retained or replayed.

The browser and Node adapters enforce the Relay wire ceiling on the physical socket and feed an item-and-byte-bounded live queue. The browser adapter also admits `ws:` on `127.0.0.1`, `localhost`, or `[::1]` when a WebView cannot present the listen certificate. A blocked consumer or oversized inbound frame closes the socket instead of accumulating unowned ciphertext. Received ciphertext must name the active route and target attachment before the endpoint callback can observe it. The development-only AES-GCM helper seals Encrypted Companion messages for keyless Desktop and Mobile; it is not a reviewed product cipher.

The Desktop Settings owner starts this lifecycle only while Mobile Access is enabled. Window close quits the Desktop process, and sleep, quit, sign-out, or disabling Mobile Access stops and drains the socket. There is no daemon, background Host, or remote wake path.

## Model Experience

None, as Remote Access transport values never enter a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Product composition supplies the validated WSS URL, retry and heartbeat intervals, and live-queue limits; this package owns the Node and browser adapters, lifecycle, and encoded Relay frames.
- Production use still requires a reviewed handshake provider in the Platform deployment.
