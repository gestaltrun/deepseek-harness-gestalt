# Remote Access client

English | [中文](README.zh.md)

Authenticated Desktop and Mobile HTTP transport for the public Remote Access service. It forwards one current-Installation Account proof per operation and validates every JSON response before exposing branded Personal Pairing identifiers. `QUOTA` and `PLATFORM_CAPACITY` responses preserve integer `retryAfter` seconds on the thrown `RemoteAccessError`.

The HTTP client does not implement a handshake or store pairing keys. Product controllers supply signed-in Account authorization while endpoint-owned Snow owners exchange opaque handshake messages through the Platform mailbox. After confirmation, the Mobile pairing controller opens its sealed endpoint-specific Relay authority through the crypto adapter and configures `MobileRelayEndpointLifecycle`; the lifecycle can send on the live attachment, and `unpair()` calls `configure(undefined)` so the lifecycle has no authority. The controller never receives the Desktop credential.

`RemoteRelayEndpointController` owns one outbound Mobile or Desktop WSS lifecycle through the deployment's single non-sticky Platform endpoint. Every physical connection obtains a fresh attachment id, requests a tuple-bound challenge using its public SPKI, and signs that challenge with its rotatable endpoint-private P-256 key. The controller waits for the matching Platform ready acknowledgement before resynchronizing, publishes contained `onConnectionReady` and `onConnectionLost` observations for that attachment generation, and passes the physical lifecycle abort signal to inbound ciphertext ownership. Desktop grant replacement invalidates the pairing callback before stopping its controller; stop aborts pending callbacks before draining the socket. A Desktop projection owner can reconnect one pairing without retiring its durable grant; the serialized transition stops the old physical attachment before starting its replacement. Socket loss starts a new connection after the validated retry delay; Desktop emits its authoritative encrypted resynchronization after every attachment. A `PLATFORM_CAPACITY` attachment failure waits for the larger of the configured reconnect delay and the server's `retryAfterMs`; the observer receives that effective delay. The wire accepts positive safe-integer delays without a smaller ceiling, so the client schedules values above the runtime timer maximum in ordered chunks instead of reconnecting early. Recognizable encrypted Companion failures retain both `COMPANION_UPDATE_REQUIRED` and `COMPANION_SECURITY_CAPABILITY_MISSING` update endpoints; only unclassified connection failures become `REMOTE_OFFLINE`, and observer failure cannot interrupt reconnection. Sends fail with `REMOTE_OFFLINE` while disconnected and are never retained or replayed.

The browser and Node adapters enforce the Relay wire ceiling on the physical socket and feed an item-and-byte-bounded live queue. A blocked consumer or oversized inbound frame closes the socket instead of accumulating unowned ciphertext. Received ciphertext must name the active route and target attachment before the endpoint callback can observe it.

The Desktop Settings owner starts this lifecycle only while Mobile Access is enabled. Window close quits the Desktop process, and sleep, quit, sign-out, or disabling Mobile Access stops and drains the socket. There is no daemon, background Host, or remote wake path.

## Model Experience

None, as Remote Access transport values never enter a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Product composition supplies the validated WSS URL, retry and heartbeat intervals, and live-queue limits; this package owns the Node and browser adapters, lifecycle, and encoded Relay frames.
- Production use still requires a reviewed handshake provider in the Platform deployment.
