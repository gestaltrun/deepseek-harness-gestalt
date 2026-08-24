# Agent Note: Mobile Companion for a paired online Desktop

Status: proposed

English | [中文](2026-08-17-mobile-companion.zh.md)

The real product path and foreground-only lifecycle are owned by [Use the real Companion product path](../architecture/2026-08-22-real-companion-product-path.md), which supersedes this proposal's push delivery and proof-path acceptance clauses. [Project live Sessions as bounded replacements](../../implemented/architecture/2026-08-24-companion-live-session-projection.md) implements the open-transcript and hidden-summary projection described here; the remaining proposal stays active.

## Problem

DeepSeek Gestalt exposes the Session Surface only through a Desktop Host that loads its loopback Web Host. A person cannot use a phone on another network to inspect ongoing work, answer an interaction, or continue a Session. The existing Web Host is not a remote-access service: exposing it directly would make agent capabilities reachable without device authentication, transport security, revocation, or a versioned independently released client protocol.

## Proposal

Add **Mobile Companion**, a human-operated mobile product that reaches a personally Paired Desktop from any network while that Desktop is online. The Paired Desktop remains required for every live operation; continuing agent execution after it goes offline is outside the first product promise.

The Companion Surface reuses the DeepSeek Harness Client Runtime and page components through a mobile-specific composition and overlay inside a thin native container. It does not independently reimplement the Session state model or squeeze the existing Desktop layout into a narrow viewport.

The first product scope includes Workspace and Session browsing, history and live streaming, prompt submission and cancellation, attachments, approvals, and human questions. Desktop settings, credentials, plugin configuration, Workspace administration, terminal use, complete tool inspection, organization sharing, and agent-operated mobile-device automation remain outside this scope.

Platform provides a simple Platform Account created through GitHub sign-in. Every GitHub account may register and receive service without a pilot allowlist. Platform Account is a shared person identity for Platform Capabilities, but it grants no Session, Desktop, device, or future-capability authority by itself.

GitHub sign-in uses a GitHub OAuth App Authorization Code flow with PKCE in the system browser, an unguessable `state`, and one fixed HTTPS Platform callback; Device Flow is disabled. It requests no OAuth scope, exchanges the code on Platform, calls `GET /user`, and records the identity as `account_identity(provider, subject)`, where the only accepted first-version provider is `github` and subject is GitHub's immutable numeric user id. Login and avatar are refreshable presentation fields; email, repository, organization, and other GitHub data are not requested. Platform discards the GitHub access token after identity validation. One account has exactly one external identity in the first version; identity linking, unlinking, and account merge are unavailable.

Each Desktop or Mobile installation has one proof-of-possession Account Session and can hold one Platform Account at a time. A P-256 ECDSA Account Session Key is independent from Noise X25519 pairing keys; Mobile creates it through its native Secure Enclave or Android Keystore adapter where supported, while Desktop protects its key with operating-system credential storage. Platform issues a fifteen-minute access token and a rotating refresh token valid for at most thirty days, while refresh and pairing operations require a signature from that key. Signing out closes that installation's Platform connections and revokes its Account Session but preserves Personal Pairings; signing back into the same account restores their use without re-pairing. Switching account requires sign-out and keeps the other account's pairings, keys, cache, and operation receipts isolated. Replacing an Account Session Key requires GitHub sign-in but does not replace valid Personal Pairing keys.

Current-installation sign-out commits a higher `sessionRevision` in PostgreSQL, updates Redis, and publishes a cross-instance invalidation event. Access tokens carry account id, session id, and revision; HTTP requests, WSS attachment, pairing operations, and heartbeats compare that revision, and every Platform Instance closes a matching active socket on invalidation. Redis uncertainty makes new authenticated operations fail closed and closes an active Account Session at its next heartbeat. The first version has no account-wide authentication epoch, cross-installation Account Session list, remote sign-out, or sign-out-all operation.

A native login uses a five-minute, single-use Login Attempt instead of a callback token or custom URL scheme. The installation creates PKCE material, a 256-bit attempt secret, and its Account Session public key, then opens the system browser. The fixed Platform callback validates GitHub and marks the attempt complete; the installation uses signed polling and proves the PKCE verifier plus its private key to redeem the Account Session. Tokens never appear in a browser URL.

GitHub authorization revocation prevents a future GitHub login but does not immediately revoke an already issued Account Session. The first version does not retain a GitHub token, poll GitHub, or consume authorization-revocation events; the Platform session remains valid until explicit sign-out, Platform disablement, or its thirty-day maximum expiry.

Desktop and Mobile must authenticate the same Platform Account before Personal Pairing can complete. Platform checks the account at challenge creation and exchange, then Personal Pairing authorizes the mobile installation to the DeepSeek Gestalt installation as an independently revocable Device Principal. A Pairing Challenge cannot share a Desktop with another Platform Account, and account identity never replaces possession of the Noise pairing keys.

The first version has no Platform Account deletion, cross-installation Account Session management, or lost-installation recovery flow. Desktop and Mobile show GitHub login and avatar, the current installation session, current-installation sign-out, and their existing Personal Pairing controls; the HTTPS OAuth callback page only reports success or failure. Account identity and metadata remain under the accepted retention rules after sign-out.

Open registration uses validated resource quotas rather than an allowlist. One account may retain at most ten Desktop installations, ten Mobile installations, fifty Personal Pairings, and twenty concurrent Platform connections. It may create ten Pairing Challenges per hour, while one IP may create thirty per hour. It may hold five concurrent ciphertext blobs and upload at most 1 GiB per day under the existing 100 MiB per-blob ceiling. Exceeding a quota returns a stable error and retry time. IP limits protect authentication and pairing only; they do not throttle established ciphertext streams.

The two-instance deployment has no account-count ceiling or automatic scaling. When aggregate connection or resource watermarks are reached, Platform preserves existing connections and rejects new login, pairing, blob upload, or WSS attachment with `PLATFORM_CAPACITY` and `retryAfter`; CloudMonitor alerts operators to expand capacity. The first version has no operator account-disable control or administration console.

Before GitHub authorization, Platform presents a bilingual privacy notice covering GitHub id, login and avatar, installation and pairing metadata, seven-day raw-IP logs, thirty-day content-free security events, expiring ciphertext blobs, and the absence of an in-product Platform Account deletion flow. Continuing sign-in accepts that notice without a separate checkbox.

The Paired Desktop is the sole authority for Session events, Workspaces, credentials, and agent execution. A mobile mutation succeeds only after the Desktop commits or confirms it; neither Mobile Companion nor the cloud keeps a writable Session replica.

The cloud service provides device discovery, routing, presence, revocation enforcement, and opaque traffic relay. Application-layer end-to-end encryption between Mobile Companion and the Paired Desktop keeps transcripts, prompts, tool parameters, approvals, and attachments unavailable to the relay, while routing and traffic metadata remain visible.

Each Personal Pairing creates an independently revocable Device Principal limited to Companion Surface operations. Prompt submission still uses the Session's existing tool and approval policy, while settings, credentials, plugins, terminal, and native Desktop operations remain unavailable. Remote mutations and interaction answers identify the Device Principal in the Desktop audit trail.

Each Mobile Companion installation generates its own asymmetric device key pair and binds the public key to its Device Principal. A narrow Capacitor native adapter protects private key material at rest with a hardware-backed operating-system wrapping key where available and deletes it on unpairing. Standard Noise X25519 operations may still use unwrapped key material in application memory; the product does not claim that Secure Enclave or StrongBox performs those operations. Short-lived relay credentials may authorize connection setup, but no long-lived bearer token can prove the Device Principal by itself.

Personal Pairing uses `Noise_XKpsk3_25519_ChaChaPoly_SHA256`, with Mobile Companion as initiator and Desktop as responder. Desktop creates a static Noise key dedicated to that Personal Pairing, and its two-minute, single-use Pairing Challenge carries a 256-bit invitation secret, the Desktop public key and full fingerprint, a Relay rendezvous id, expiry, and protocol major. Both endpoints derive matching short authentication words from the Noise handshake hash, and the Desktop user confirms before the pairing and its keys become active. A full one-time link is the non-camera fallback; the first version has no low-entropy manual code. Successful exchange is idempotent, while expiry, cancellation, rejection, or one successful use destroys the invitation secret and makes the challenge unusable.

Later connections use `Noise_IK_25519_ChaChaPoly_SHA256` with the public keys retained by that Personal Pairing. Each connection generates fresh ephemeral keys and never reuses the invitation secret. The Noise handshake hash provides channel binding for application-version negotiation and peer authentication.

The protocol target does not predetermine its product library. Two bounded prototypes evaluate `snow` compiled to WASM for the target XKpsk3-to-IK flow and `@chainsafe/libp2p-noise` as a maintained XX fallback over a Relay-backed duplex stream. A candidate may ship only after official Noise vectors, Node 22 and 24, iOS WKWebView, Android WebView, tamper, replay, ordering, cross-pairing, reconnect, and resource-limit checks plus independent security review. Product code does not fork a library's internal handshake implementation or assemble a new cryptographic protocol from primitives.

Device private keys have no cloud backup or relay recovery path. Reinstalling Mobile Companion or moving to another phone creates a new Device Principal and requires another Personal Pairing. The old principal remains independently visible and revocable until the Desktop user removes it.

The first version has no global cryptographic Desktop Principal. Enabling remote access creates an opaque route id and a rotatable high-entropy Relay credential; Desktop proves that credential when attaching its outbound WSS connection, never a route id or query parameter alone. Each Personal Pairing separately authenticates the encrypted application peer, so a stolen route credential can disrupt route availability but cannot pass pairing-key authentication or decrypt Companion traffic.

The Companion Surface source shares the DSH Client Runtime and page components in this monorepo, while each mobile release bundles its compiled page assets. A Paired Desktop and the relay never supply executable page code to the application at connection time.

`apps/mobile` uses Capacitor as the native container for the locally bundled Companion Surface. The web Client owns page rendering; native adapters own camera access, device keys, deep links, file selection, and encrypted local storage. The prior Expo and React Native implementation remains behavioral reference material rather than a source of page code.

A new Remote Access Platform Capability replaces the prior plaintext Java gateway. It owns the Personal Pairing registry, Remote Relay, and encrypted-blob capability as one deep module. Both Mobile Companion and Desktop establish outbound WSS connections to its Remote Relay, whose interface contains no Workspace, Session, prompt, tool, model, approval, or other DSH business type.

`apps/platform` is the independently deployable Cordis composition root for centralized Platform Capabilities in this monorepo and does not mount Harness Engine. Account and Remote Access are its initial capabilities rather than the application's deployment identity. The proposed `@deepseek-ai/dsh-platform-account` package is a deep Account plugin that owns GitHub OAuth, Platform Account, Account Session, installation-key binding, and current-installation sign-out. Remote Access consumes its Account Service to validate sessions and same-account pairing without reading account tables or GitHub fields. Platform otherwise shares only process lifecycle, validated configuration, health endpoints, and PostgreSQL, Redis, OSS, logging, and secret adapters; every capability owns its authorization, tables, Redis namespace, routes, and observability fields. Later capabilities may recognize Platform Account identity but cannot reuse Remote Access Device Principals, data, or decrypted values without a separate decision.

Remote Access uses four proposed deep packages. `@deepseek-ai/dsh-remote-protocol` owns wire codecs, version and capability negotiation, stable errors, branded ids, parser limits, and Noise vectors. `@deepseek-ai/dsh-remote-platform` owns the complete Platform plugin and keeps pairing, relay, blob, and cross-instance coordination internal. `@deepseek-ai/dsh-remote-desktop` owns Desktop connection lifecycle, DSH projections, operation idempotency, and audit attribution. `@deepseek-ai/dsh-remote-client` owns the Mobile synchronization state machine, operation receipts, and cache interface. Application directories compose these modules but do not duplicate their state machines.

The network uses two protocols. Relay Transport Protocol frames route attachment, ciphertext, heartbeat, revocation, transport errors, and transport-version negotiation that the Relay can read. Encrypted Companion Protocol runs inside that ciphertext and carries only the projections, operations, results, and application-version negotiation approved for the Companion Surface. A Desktop adapter maps that narrow protocol to existing DSH Session and Host capabilities; the remote route never tunnels the complete `/api/*` or Host WebSocket interface.

Every Noise message follows the protocol's 65,535-byte fixed ceiling, and one encrypted application payload is at most 60 KiB. Transcript pages contain at most fifty events or 48 KiB of encoded content, whichever comes first; one event that exceeds the page allowance uses existing bounded projection and spill behavior. The initial validated Platform defaults limit one ciphertext blob to 100 MiB with a fifteen-minute lifetime, one connection to sixty-four queued frames or 4 MiB, heartbeat emission to twenty seconds, and offline detection to sixty seconds. Noise message size, parser depth, and encoded-value safety ceilings are protocol invariants; blob, lifetime, queue, heartbeat, and presence values remain validated deployment configuration.

Remote Access never keeps an offline message queue. A missing target returns `REMOTE_OFFLINE`. Cross-instance forwarding and per-connection queues never silently drop or reorder an accepted frame; a slow consumer that exceeds either queue limit is disconnected, then both peers reconnect and recover from Desktop authority. A mutation whose result remains unknown uses operation-id lookup rather than Relay replay.

The two protocols negotiate independently. Every peer declares a supported version interval and capabilities; additive features remain negotiable within one major. Desktop supports the current and immediately preceding Companion major without weakening a required security capability. Peers with no safe overlap fail closed and identify which endpoint requires an update.

Relay database changes use expand-contract migrations that remain compatible with both application revisions during a rolling deployment; automatic down migrations are not supported. Mobile stores versioned pairing-key records separately from its disposable Companion Cache, so an upgrade failure may require rebuilding cache but does not require re-pairing. An application outside the supported Companion protocol interval must update instead of negotiating away required security.

One mobile device may retain multiple Personal Pairings, and one Desktop may authorize multiple devices; each operation selects one Paired Desktop and pairings never merge Sessions across Desktops. Remote access is disabled by default and begins only after a Desktop user enables it and completes Personal Pairing.

DeepSeek Gestalt Settings contains a Mobile Access page for enablement, adding a device, displaying the Pairing Challenge, and listing each device's name, platform, online state, pairing time, last authenticated access, individual revoke action, and revoke-all action. Mobile Companion's Paired Desktop list shows connection state and last connection, and offers unpair and per-Desktop cache clearing. Neither surface exposes a device IP address.

The Paired Desktop is Remote Online only while mobile access is enabled and its DeepSeek Gestalt window remains open. Closing the window, quitting the application, putting the computer to sleep, or disabling mobile access makes it Remote Offline. Mobile Companion may show its last Desktop-confirmed Companion Cache while offline but cannot queue prompts, cancellations, approvals, or other mutations. The first version has no background Host, system daemon, or remote wake.

Companion Cache retains encrypted-at-rest Workspace and Session metadata plus transcripts that the user opened on that device. It does not automatically retain attachment bytes, terminal content, spill files, or credentials, and the user can clear all cached content for one Paired Desktop.

Attachments use end-to-end encrypted blob transfer instead of application plaintext or large messages in the live stream. Mobile Companion encrypts the bytes before upload; the Relay issues a Personal-Pairing-scoped capability with size and expiry limits; Desktop verifies the ciphertext hash, downloads, and decrypts it. Expiry, revocation, or successful receipt removes the blob. The WSS path carries control messages and bounded small frames only.

Mobile Companion learns current state only after the user opens or foregrounds the application. Backgrounding pauses WSS; foregrounding reconnects to the selected Paired Desktop and completes authenticated Desktop-authoritative synchronization before enabling any mutation. The product has no background notification delivery.

The first deployment is a single-region initial service sized for roughly fifty Desktops but open to every GitHub-authenticated account. It supports multiple concurrent Platform Instances from its first release. Remote Relay routing and ciphertext forwarding work when Mobile and Desktop attach to different Platform Instances. Multi-region routing remains outside the initial deployment, and deploys may reconnect peers rather than migrate live sockets.

The pilot deploys exactly two stateless Platform Instances on separate Alibaba Cloud compute instances behind one TLS load balancer without connection affinity. Alibaba Cloud managed PostgreSQL stores durable pairing, revocation, blob-metadata, and content-free security-audit records. Managed Redis keeps the expiring online connection directory and carries cross-instance ciphertext Pub/Sub without becoming an offline queue. OSS retains only expiring ciphertext blobs through the object-storage adapter. When a Platform Instance exits or a rolling deployment replaces it, attached peers reconnect and resynchronize through the other instance.

Alibaba Cloud SLS and CloudMonitor receive content-free operational signals: connection counts, authentication failure categories, cross-instance forwarding latency, reconnects, revocation propagation, blob byte and expiry totals, dependency health, and structured error codes. Logs and traces never contain ciphertext bodies, public keys, device names, Pairing Challenges, full links, or complete route and pairing ids. Cross-instance correlation uses random request ids, while identifiers exposed to aggregate telemetry use HMAC pseudonyms under a rotating deployment key.

Platform configuration references Alibaba Cloud KMS or Secrets Manager values, or secrets injected by deployment. PostgreSQL, Redis, OSS, and GitHub credentials never enter the database, repository, `cordis.yml`, or logs. A capability with a missing required credential fails to load with a specific diagnostic instead of silently disabling or weakening its behavior.

The first version relies on Alibaba Cloud's managed backup and disaster-recovery facilities. It does not implement an application-level restore epoch, suspend all pairings after restore, orchestrate cross-region failover, back up Redis connection state, or recover expiring ciphertext blobs. A stale Relay record still cannot authenticate a revoked device after Desktop deletes that Personal Pairing's key, but cloud restore procedure and availability targets remain deployment configuration rather than product protocol.

Development and production each use a separate GitHub OAuth App, Platform origin, callback, client credential, database, and identity namespace. Each build trusts only its corresponding Platform origin. The first version has no staging environment and does not accept an arbitrary server URL from a user or Pairing Challenge; the QR and full link identify only a rendezvous and challenge within that trusted origin. Self-hosted Platform selection and custom trust roots require a later deployment decision.

The Capacitor project keeps both iOS and Android builds healthy. Initial distribution uses TestFlight and a signed Android APK; public App Store and Google Play publication wait for real-device pairing, key storage, deep-link, foreground synchronization, cache, and upgrade acceptance.

Remote operation attribution is durable but not model-visible. The Paired Desktop records operation id, Device Principal, operation category, acceptance, and result; ordinary conversation presentation remains unchanged, with device origin available in details. The model never receives device name, IP address, or network origin.

The first Encrypted Companion Protocol catalog can list Paired Desktops, Workspaces, Sessions, history, live projections, shared message and tool cards, pairing state, and pending interactions. It can create a Session either in an existing Workspace with Desktop defaults or without a Workspace as an Ungrouped Session, submit prompts and attachments, cancel active execution, answer human questions, settle approvals, and revoke its own pairing. It cannot administer Workspaces, select presets or models, edit general settings, rename, archive, delete, or fork Sessions, or provide terminal input.

Mobile approval renders the same exact arguments, cwd, diff, terminal summary, and decision options that the Desktop Approval Service authorizes. It does not remove persistent authorization or other valid Desktop choices, and it does not invent a mobile-specific policy layer. The Desktop remains the authority that commits the decision and its Device Principal attribution.

A deep link never carries interaction authority. Pairing links identify one short-lived Pairing Challenge; Mobile Companion reconnects and synchronizes before presenting any current Desktop-owned action or settled outcome.

Mobile Companion pauses its WSS connection while backgrounded. Opening or foregrounding the application reconnects and resynchronizes authoritative state. The first version does not depend on a silent background task or keep a background socket alive.

Mobile navigation does not reproduce Desktop columns. The root selects a Paired Desktop, Workspace filters its Session list, and one Session occupies the full conversation view. A visible interaction inbox and in-conversation cards expose approvals and human questions. Only the open transcript receives live detail; hidden Sessions update summaries.

The Companion Surface reuses shared Markdown, code, image, ordinary tool, diff, approval, and Ask User renderers. Terminal output appears only as a bounded read-only summary under existing truncation and spill rules, with no terminal input. An unknown tool remains visible through a generic read-only card that preserves its available arguments and result instead of hiding unsupported content.

Ungrouped Session behavior remains consistent with Desktop. Mobile Companion can view and continue an existing Ungrouped Session, and its Session creation flow treats Workspace as optional: omitting it creates an Ungrouped Session through the Paired Desktop's normal creation behavior.

Mobile Companion has no separate biometric or application-lock feature. It relies on operating-system device access control, protected key storage, and encrypted local storage.

Revocation first commits a higher pairing revision in PostgreSQL, updates its current Redis revision, and publishes a cross-instance revocation event. Each Relay closes matching active sockets immediately and verifies the current revision again on heartbeat so a missed Pub/Sub event cannot preserve access. If Redis cannot confirm validity, new attachment fails closed and an active pairing closes at its next check. Individual revocation deletes that pairing's Desktop key; revoke-all or disabling Mobile Access also rotates the Desktop Relay credential and closes the Desktop route.

The Relay durably retains public keys, pairing state and revision, and revocations. It deletes ciphertext blobs on receipt or expiry. Presence, heartbeats, routes, and ciphertext frames remain process-local. Content-free security events remain for thirty days, while raw IP access logs remain for no more than seven days.

The Paired Desktop orders concurrent local and mobile operations by authoritative acceptance and commit. Each remote mutation carries a globally unique operation id and Device Principal so retries are idempotent. A one-shot interaction, cancellation, or other first-commit-wins operation returns the already-settled authoritative result to a later caller instead of overwriting it.

Mobile Companion durably keeps an operation receipt only after sending a mutation whose result is not yet known. Reconnection queries the Paired Desktop by operation id: a committed operation returns its original result, while an explicitly absent operation becomes not submitted and waits for the user to choose whether to retry. The application never automatically replays a stale receipt, and the receipt is not an offline mutation queue.

The system and store name is **DeepSeek Gestalt**, while Mobile Companion remains the domain term for its mobile role. The mobile application uses bundle identifier `com.gestalt.deepseek.mobile`. It inherits DSH design tokens, shared renderers, Chinese and English terminology, and light and dark themes rather than the prior mobile application's beige and orange identity. The initial theme and language follow the operating system, after which the same explicit user choices as DSH take precedence.

Delivery proceeds in dependency order: bounded cryptographic prototypes and the security-review entry point; Remote Protocol and cross-runtime vectors; the Platform Remote Access plugin and two-instance routing; the Desktop adapter, Mobile Access settings, and audit trail; Mobile Client Runtime plus Capacitor key and cache adapters; then assembled pages, blobs, real-device acceptance, and failure testing. A later layer does not substitute mocks for an unfinished lower-layer acceptance path.

Keyless assembled-application snapshots cover logged-out Pairing Challenge refusal, cross-account pairing refusal, same-account Workspace and Ungrouped Session creation, Mobile prompt attribution without model-visible device data, Mobile Approval and Ask User completion, Remote Offline plus uncertain-operation recovery, and post-revocation rejection. Package and integration tests own OAuth, Noise, parser ceilings, idempotency, revision invalidation, and two-instance failure paths; iOS and Android devices own native key, foreground lifecycle, cache, and page acceptance.

## Alternatives considered

**Limit the product to one local network.** Rejected because the principal value is responding to ongoing Desktop work while away from that network.

**Continue execution in the cloud after Desktop disconnects.** Rejected from the first product promise because it requires a second Harness Engine plus Workspace, credential, execution-environment, and Session authority migration rather than remote access to one Desktop.

**Reimplement the pages as an independent React Native product.** Rejected because a second Session state model and interaction renderer would drift from the existing Client Runtime and page components.

**Render the existing Desktop page unchanged at phone width.** Rejected because Desktop navigation and information density do not define a usable mobile interaction model.

**Start with organization sharing or complete Desktop parity.** Rejected because shared principals and privileged configuration operations enlarge the authorization model before the personal remote workflow is established.

**Use Personal Pairing without a Platform Account.** Rejected because the first release requires GitHub-authenticated account access before pairing. The account identifies the person but does not replace Device Principal authorization or create organization sharing.

**Allow a Pairing Challenge to cross Platform Accounts.** Rejected because the first account model gates personal devices rather than sharing a Desktop; both endpoints must authenticate the same account before the Noise pairing grant is created.

**Use GitHub Device Flow or retain GitHub tokens for Platform sessions.** Rejected because the system-browser Authorization Code flow supports PKCE, while Platform needs GitHub only to validate one immutable user id. Its own proof-of-possession Account Session owns service access.

**Return an account token through a custom application URL scheme.** Rejected because another installed application may claim the scheme. A short-lived Login Attempt keeps the OAuth callback and token exchange on Platform and binds redemption to PKCE plus the installation key.

**Reuse a Noise X25519 key as the Account Session signing key.** Rejected because pairing encryption and Platform login have different rotation and storage lifecycles. A separate P-256 signing key lets native platforms use their supported hardware key operations without changing the standard Noise suite.

**Request GitHub email, repository, or organization access.** Rejected because public profile identity is sufficient for the first Platform Account, and unrelated OAuth scopes would enlarge credential exposure.

**Require immediate Platform-session revocation when GitHub authorization is removed.** Deferred because the first version discards the GitHub token and does not add GitHub polling or authorization webhooks. Existing Platform sessions retain their bounded lifetime.

**Support concurrent accounts in one application installation.** Rejected because one-account installation state keeps pairings, keys, caches, and operation receipts isolated without an account-switching state matrix.

**Build a complete web account console.** Rejected from the first version because Desktop and Mobile own account and device controls; the Platform web surface only completes OAuth.

**Provide cross-installation Account Session recovery, remote sign-out, or sign-out-all.** Rejected from the first version; an installation can sign out only its current Account Session, while Personal Pairing controls remain separate.

**Provide Platform Account deletion.** Rejected from the first version. The pre-login privacy notice states that no in-product account deletion flow exists.

**Restrict account creation to a GitHub id allowlist.** Rejected because the first service is open to every authenticated GitHub account rather than a closed pilot cohort.

**Treat open registration as unlimited resource authority.** Rejected because per-account, installation, pairing, blob, and authentication quotas bound the cost of one identity without closing registration.

**Automatically scale Platform or terminate existing connections at capacity.** Rejected from the first deployment because two purchased instances remain fixed; load shedding protects existing connections and reports explicit retry timing until an operator expands them.

**Add an operator account-disable command or administration console.** Deferred from the first version; users retain current-installation sign-out and Personal Pairing revocation, while quotas and capacity shedding provide the accepted service protection.

**Share one GitHub OAuth App or account namespace across environments.** Rejected because development and production have separate origins, credentials, callbacks, databases, and identities; no staging environment exists in the first version.

**Let Remote Access read account tables directly.** Rejected because Account is an independent Platform Capability; its service authorizes sessions and same-account relationships without exporting provider-specific storage.

**Ship a read-only viewer.** Rejected because prompt continuation, cancellation, approvals, and human questions are the time-sensitive reasons to use a phone.

**Combine Mobile Companion with mobile-device automation.** Rejected because a human client projecting DeepSeek Gestalt Sessions and an agent tool controlling mobile applications have different actors, permissions, and lifecycles.

**Let the cloud gateway process application plaintext.** Rejected because the relay does not need transcript, tool, approval, or attachment content to route a personal connection, and holding that content would create another privileged data processor.

**Replicate writable Session state to Mobile Companion or the cloud.** Rejected because dual write authority introduces conflict and recovery rules that the Desktop-owned append-only Session log already avoids.

**Treat a paired device as the complete Desktop user.** Rejected because possession of one mobile credential must not expose configuration, credentials, terminal access, or native Desktop operations.

**Queue mobile mutations while Remote Offline.** Rejected because prompts may rely on stale context and delayed cancellation or approval may target work that has already settled.

**Restrict the data model to one phone and one Desktop.** Rejected because independently revocable pairings preserve the same personal trust model without baking a singleton into identity and storage formats.

**Keep a background Host or install remote-wake support.** Rejected from the first version because closing the window is the user's simple stop control; background lifecycle, operating-system integration, and wake authorization add complexity before the foreground remote path is established.

**Enable remote access on installation.** Rejected because a code-execution product must not establish an internet-reachable route until the Desktop user deliberately enables and pairs it.

**Use a long-lived server-signed JWT as the device identity.** Rejected because bearer possession would let the issuing service or a token leak impersonate a paired device without proof of its private key.

**Assemble a custom authenticated handshake from cryptographic primitives.** Rejected because X25519, KDF, and AEAD libraries do not define transcript binding, role authentication, replay handling, or downgrade behavior. The implementation targets a registered Noise pattern and must pass its standard vectors.

**Select or fork a Noise implementation before cross-platform prototyping.** Rejected because no evaluated maintained JavaScript package directly satisfies the chosen pattern, runtime, and native-key constraints. Bounded prototypes and an independent security review precede the product dependency decision.

**Promise that all X25519 private-key operations remain inside secure hardware.** Rejected because Secure Enclave and StrongBox do not provide that portable Noise guarantee. Hardware-backed wrapping protects static storage where available without overstating execution isolation.

**Download executable Companion Surface code from the Paired Desktop.** Rejected because independently reviewed mobile releases need deterministic application code and an offline-capable shell; compatibility belongs in an explicit remote protocol.

**Add background notifications before the product has a native delivery path.** Rejected because dormant token, credential, persistence, privacy, quota, and compatibility surfaces do not deliver an alert. Foreground synchronization is the accepted lifecycle.

**Resolve concurrent operations with client clocks or last-writer-wins.** Rejected because only the Paired Desktop can order committed Session and interaction state, and retries must not duplicate mutations.

**Cache every synchronized byte for offline use.** Rejected because attachments, terminal output, spill files, and credentials enlarge local exposure without serving the core read-only history workflow.

**Retain a six-character manual pairing code.** Rejected because a low-entropy code cannot authenticate the encrypted peer without a PAKE or another confirmation mechanism; a full one-time link preserves the QR challenge's entropy with less protocol complexity.

**Back up or recover device private keys through the Relay.** Rejected because recovery authority would let the cloud replace a Device Principal. Device replacement instead creates a new principal and pairing.

**Adapt the prior Java application gateway.** Rejected because it parses plaintext business envelopes, stores plaintext attachments, uses a permanent bearer JWT, assumes one Desktop per device row, trusts a Desktop id query during WebSocket attachment, and depends on Alibaba-specific deployment infrastructure.

**Let Platform become a shared business gateway or let capabilities inherit every account permission.** Rejected because the composition root shares infrastructure, not authority or plaintext. Each Platform Capability separately authorizes what a Platform Account may do.

**Split pairing, relay, and blobs into independent shallow Platform services.** Rejected because they jointly implement one Remote Access lifecycle and authorization model; the deep capability keeps their implementation internal while Remote Relay remains a narrow transport component.

**Keep Expo and React Native as the page runtime.** Rejected because the accepted Companion Surface shares the existing React web Client; Capacitor provides the required native adapters without creating another page renderer.

**Send attachments through the live WebSocket or store plaintext.** Rejected because large frames interfere with interactive traffic and plaintext storage would contradict the opaque Relay role.

**Tunnel the complete existing Host interface.** Rejected because its lockstep, loopback-oriented operations include capabilities outside the Device Principal grant. A narrow encrypted protocol makes the allowed remote interface explicit.

**Introduce a global Desktop Principal in the first version.** Deferred because per-pairing keys already authenticate the encrypted application peer. A rotatable Relay credential is sufficient for pilot route attachment, accepting that its compromise can disrupt availability.

**Trust a Desktop route id or query parameter.** Rejected because an identifier does not prove route ownership; even the simplified pilot requires a high-entropy credential during outbound connection attachment.

**Use one shared protocol version.** Rejected because the Relay must reject incompatible transport frames without learning the encrypted application version, while Mobile and Desktop must negotiate independently released Companion capabilities end to end.

**Ship a single-instance Relay for the pilot.** Rejected because the first deployable architecture must route between concurrent instances even at controlled scale. Multi-region routing and live-socket migration remain unnecessary.

**Require sticky sessions or migrate live sockets during deploys.** Rejected because the connection directory and cross-instance forwarding allow either peer to use any Platform Instance, while reconnect and resynchronization preserve application authority without transport migration.

**Add application-owned cross-region disaster-recovery orchestration.** Deferred because the first deployment uses Alibaba Cloud managed backup and disaster-recovery capabilities. Redis routes and expiring ciphertext blobs are reconstructible or disposable, and E2E pairing authentication remains Desktop-owned.

**Put an arbitrary Relay URL in the Pairing Challenge.** Rejected because the initial distributed application has a configured trusted origin; accepting an untrusted server address would add server selection and trust-root policy to personal pairing.

**Name the cloud application after Remote Relay.** Rejected because Relay is one component of the first Platform Capability, while the same centralized deployment will host other independently authorized capabilities later.

**Run both Platform processes on one compute instance.** Rejected because the accepted Alibaba Cloud deployment purchases two separate instances behind the load balancer.

**Publish immediately through the public mobile stores.** Rejected because controlled TestFlight and signed-APK distribution can validate native security and lifecycle behavior before creating public upgrade obligations.

**Make device origin model-visible or visually prominent.** Rejected because source attribution is an audit and detail concern, not model context or primary conversation content.

**Persist live routes, heartbeats, ciphertext frames, or indefinite access logs.** Rejected because reconnect reconstructs live routing, encrypted frames are not application authority, and indefinite metadata retention does not serve the pilot.

**Queue ciphertext for an offline or slow peer.** Rejected because the Relay is not application authority; missing targets fail explicitly and bounded slow consumers reconnect and resynchronize from Desktop state.

**Log ciphertext, durable identifiers, device names, keys, tokens, or Pairing Challenges for diagnosis.** Rejected because content-free metrics and rotating pseudonyms provide operational correlation without making sensitive values an observability data set.

**Store cloud-provider or OAuth credentials in application data or repository configuration.** Rejected because Platform consumes deployment-managed secret references and fails loud when a required secret is unavailable.

**Keep the Relay in a separate repository or mount Harness Engine inside it.** Rejected because same-change protocol verification requires one source tree, while the opaque Relay does not own agent execution or Session semantics.

**Expose Workspace administration, model selection, Session rename, archive, deletion, fork, or terminal input.** Rejected because these operations exceed the accepted Companion Surface; Session creation remains available both inside an existing Workspace and as an Ungrouped Session.

**Restrict persistent approval choices on Mobile.** Rejected because the Desktop Approval Service already owns which decisions are valid. Mobile renders that interface without another policy layer and preserves Desktop commit authority and device attribution.

**Execute approval or cancellation from an external deep link.** Rejected because link state can be stale; opening the application and resynchronizing precedes every mutation.

**Keep the mobile WebSocket alive or execute silent synchronization in the background.** Rejected because foreground resynchronization handles the accepted lifecycle without depending on constrained platform background execution.

**Reuse the Desktop multi-column navigation.** Rejected because mobile navigation centers one selected Desktop and one active Session, with summaries and interactions available through mobile-specific routes.

**Hide unsupported tool output on Mobile.** Rejected because a generic read-only card preserves inspectability when no specialized mobile renderer exists.

**Require every new Mobile Session to belong to a Workspace.** Rejected because the Mobile creation flow must allow Workspace to be omitted and create an Ungrouped Session consistently with Desktop.

**Automatically replay a mutation whose result was lost with the connection.** Rejected because the Desktop may already have committed it; operation-id lookup resolves the uncertainty before the user deliberately retries an explicitly absent operation.

**Use automatic database down migrations or place pairing keys inside disposable cache.** Rejected because rolling Relay versions need one compatible expanded schema, while mobile cache recovery must not destroy a valid Personal Pairing.

**Retain the prior mobile name, bundle id, or visual identity.** Rejected because this application is the DeepSeek Gestalt mobile surface and shares its design and terminology rather than presenting a migrated 千机 product.

**Add a separate biometric application lock.** Rejected from the product scope; operating-system access control and encrypted storage own local protection.

## Acceptance criteria

- A personally paired phone on a different network can browse Workspaces and Sessions, open history, receive live output, submit and cancel prompts, transfer attachments, and answer approvals and human questions while the Paired Desktop is online.
- The Companion Surface consumes the existing Client Runtime and shared page components through a mobile-specific composition; it does not own an independent Session state model.
- A Personal Pairing can be identified and revoked without introducing organization membership or shared-Desktop access.
- GitHub sign-in creates or authenticates a simple Platform Account, and an authenticated account is required before Desktop or Mobile can use Personal Pairing; account identity alone grants no Desktop or Device Principal authority.
- Every GitHub account may create a Platform Account without an allowlist; Desktop and Mobile must authenticate the same account before Pairing Challenge exchange succeeds.
- GitHub OAuth App login uses the system-browser Authorization Code flow with PKCE, random state, one fixed Platform callback, no OAuth scope, immutable numeric GitHub id, and no retained GitHub token.
- One installation holds one proof-of-possession Account Session and one account at a time, using fifteen-minute access and rotating at-most-thirty-day refresh tokens in secure storage.
- Account Session uses an independent P-256 installation signing key, while a five-minute signed-polling Login Attempt completes the fixed Platform OAuth callback without a token-bearing custom URL scheme.
- Signing out revokes only that installation's Account Session and closes its connection while retaining Personal Pairings; switching accounts isolates all pairing, key, cache, and receipt state.
- GitHub OAuth revocation blocks later login but does not invalidate an existing bounded Platform session in the first version.
- Current-installation sign-out propagates `sessionRevision` through PostgreSQL, Redis, and both Platform Instances; the first version provides no Account Session list, remote sign-out, sign-out-all, lost-installation recovery, or Platform Account deletion.
- Platform Account uses one `account_identity(provider, subject)` row, accepts only GitHub numeric id in the first version, and supports no identity link, unlink, or merge.
- Open registration enforces the accepted per-account, installation, pairing, connection, challenge, blob, byte, and authentication quotas with stable errors and retry timing.
- Aggregate capacity preserves established connections and rejects new resource acquisition with `PLATFORM_CAPACITY`; the two-instance deployment neither auto-scales nor exposes an operator account-disable control.
- A bilingual pre-login privacy notice discloses the accepted data and retention classes and explicitly states that the first version has no in-product account deletion flow.
- Development and production use distinct GitHub OAuth Apps, Platform origins, callbacks, credentials, databases, and identity namespaces; the first version has no staging environment.
- The Paired Desktop remains the sole Session, Workspace, credential, and execution authority; every successful mobile mutation has a Desktop confirmation.
- The relay routes end-to-end encrypted application traffic without receiving transcript, prompt, tool, approval, or attachment plaintext.
- Every remote mutation carries a Device Principal whose allowed operations exclude settings, credentials, plugins, terminal, and native Desktop access.
- Multiple devices and Desktops use independent Personal Pairings, with one Paired Desktop selected per operation and no cross-Desktop Session merge.
- Remote access is disabled by default and exposes device status, recent access, individual revocation, and revoke-all control after enablement.
- Closing the Desktop window, quitting the application, computer sleep, or disabling mobile access makes the Desktop Remote Offline without a background Host or remote wake.
- Remote Offline permits only Companion Cache viewing; no mobile mutation waits for later execution.
- A Device Principal proves possession of its installation key; a relay bearer credential alone cannot impersonate it.
- Pairing uses Noise XKpsk3 with a two-minute single-use 256-bit QR or full-link invitation, handshake-hash authentication words, and explicit Desktop confirmation; reconnect uses Noise IK with fresh ephemeral keys and no invitation-secret reuse.
- The product cryptographic dependency passes the bounded prototype matrix, official Noise vectors, cross-platform and attack-path tests, and an independent security review; product code neither forks handshake internals nor invents a protocol from primitives.
- A native adapter uses hardware-backed wrapping where available to protect mobile private material at rest without claiming that X25519 executes inside secure hardware.
- Desktop attaches to its opaque Relay route with a rotatable high-entropy credential, while Personal Pairing keys authenticate the encrypted peer; no global Desktop Principal is required.
- The installed application bundles its Companion Surface assets from shared DSH source and executes no page code supplied by the Paired Desktop or relay.
- `apps/mobile` uses Capacitor for native adapters while the shared web Client owns the Companion Surface.
- A new Remote Relay accepts only outbound Desktop and Mobile connections and handles no decrypted DSH business value.
- Relay Transport Protocol remains outside the ciphertext, while Encrypted Companion Protocol exposes only Companion operations and projections inside it; the complete Host interface is unreachable.
- Transport and Companion version intervals negotiate independently, Desktop supports the current and preceding Companion major, and incompatible peers fail closed with an update requirement.
- Relay uses expand-contract database migration during rolling deployment; mobile pairing-key records survive disposable-cache rebuilds and unsupported clients update instead of taking a security downgrade.
- Attachment plaintext exists only at Mobile Companion and Desktop, with the Relay retaining an expiring, pairing-scoped ciphertext blob.
- Opening or foregrounding Mobile reconnects and completes Desktop-authoritative synchronization before any mutation becomes available; the product has no background notification delivery.
- `apps/platform` is the Cordis composition root for centralized Platform Capabilities without mounting Harness Engine; Account and Remote Access are its initial independently authorized plugins, while future capabilities share neither Remote Access Device Principals nor its plaintext.
- The proposed `@deepseek-ai/dsh-platform-account` package owns OAuth and Account Session lifecycle behind an Account Service; Remote Access validates sessions and same-account pairing without reading account storage.
- The deep package split gives protocol, Platform Remote Access, Desktop adaptation, and Mobile synchronization one owning module each; pairing, Relay, blob, and cross-instance behavior remain internal to Remote Access rather than separate shallow services.
- The pilot supports roughly fifty Desktops across exactly two Platform Instances in one Alibaba Cloud region, plus TestFlight and signed Android APK distribution.
- The two Platform Instances run on separate Alibaba Cloud compute instances behind one non-sticky TLS endpoint, with managed PostgreSQL for durable metadata, managed Redis for the expiring connection directory and ciphertext Pub/Sub, and OSS for expiring ciphertext blobs; instance loss causes reconnect rather than lost committed state.
- Alibaba Cloud owns backup and disaster-recovery facilities for the pilot; the application does not add restore epochs, restore-time pairing suspension, cross-region orchestration, Redis backup, or ciphertext-blob recovery.
- Each release trusts its configured Platform origin, and Pairing Challenges cannot select an arbitrary server or trust root.
- Every Noise message and transcript page obeys the fixed protocol ceilings, while validated Platform configuration owns blob, expiry, queue, heartbeat, and presence defaults.
- Offline targets fail with `REMOTE_OFFLINE`; slow consumers disconnect at the bounded queue instead of losing, reordering, or durably queuing frames.
- Concurrent operations settle in Paired Desktop commit order, and retrying an operation id never repeats its mutation.
- Durable remote-operation attribution remains outside model input and ordinary conversation content but is available in UI details.
- PostgreSQL revision, Redis publication, heartbeat revalidation, and fail-closed attachment make individual and revoke-all decisions terminate active access across Platform Instances; revoke-all also rotates the Desktop Relay credential.
- Desktop Mobile Access and Mobile Paired Desktop surfaces expose the accepted enablement, pairing, status, last-access, revocation, unpair, and cache controls without IP addresses.
- Relay retention follows the accepted durable-pairing, thirty-day security-event, seven-day raw-IP, ephemeral-presence, and blob-expiry rules.
- SLS and CloudMonitor receive only the accepted metrics, health, structured errors, random request ids, and rotating HMAC pseudonyms; sensitive identifiers, device data, tokens, keys, challenges, links, and ciphertext bodies never enter telemetry.
- Platform loads PostgreSQL, Redis, OSS, and GitHub credentials only through deployment-managed secret references and fails the owning capability when a required secret is absent.
- The first protocol catalog exposes only the accepted viewing, Session creation in an existing Workspace or as an Ungrouped Session, prompt, attachment, cancellation, interaction, approval, and self-revocation operations.
- Mobile approval exposes every decision the Desktop Approval Service provides, including persistent authorization, without a separate mobile policy.
- Pairing links carry no interaction authority, mobile navigation uses a selected-Desktop and single-Session flow, and only the open transcript receives live detail.
- Backgrounding pauses WSS; opening or foregrounding the application reconnects and synchronizes without silent background execution.
- Shared Markdown, code, image, tool, diff, approval, and Ask User renderers remain available; terminal content is bounded and read-only, while unknown tools use a visible generic card.
- Mobile supports viewing and continuing Ungrouped Sessions, and omitting Workspace during creation creates an Ungrouped Session consistently with Desktop.
- An uncertain sent mutation retains only an operation receipt; reconnect resolves its operation id before any user-directed retry, with no automatic replay or offline outbox.
- The application is named DeepSeek Gestalt, uses `com.gestalt.deepseek.mobile`, and inherits DSH terminology, tokens, renderers, language, and theme choices.
- Mobile Companion has no independent application-lock feature.
- Companion Cache encrypts last-confirmed metadata and opened transcripts at rest, excludes automatically cached attachment, terminal, spill, and credential bytes, and supports per-Desktop clearing.
- Mobile Companion exposes no agent-operated mobile-device automation.
- The remote path does not expose the current unauthenticated Web Host directly.
- Delivery follows the accepted prototype, protocol, Platform, Desktop, Mobile runtime, and assembled real-device sequence.
- Keyless snapshots, package and integration tests, process-level failure tests, and real iOS and Android acceptance own the accepted account, protocol, Desktop, and Mobile paths at their respective layers.

## Risks

- The current Client and Host wire assumes lockstep publication. A separately released mobile application needs an explicit compatibility policy before the first durable distribution.
- Open GitHub registration exposes Platform compute, connection, and blob resources to any authenticated GitHub user; bounded protocol limits do not replace account-level abuse controls.
- Without an operator disable or account-deletion control, a malicious or abandoned account can be contained only by automatic quotas, capacity shedding, Account Session expiry, GitHub provider action on future login, and Personal Pairing revocation in the first version.
- Discarding GitHub tokens keeps Platform credentials minimal but means external OAuth revocation does not terminate an existing Platform session before its bounded expiry.
- A lost signed-in installation cannot be remotely signed out in the first version; its Account Session remains valid until its refresh-token lifetime ends, although a reachable paired Desktop can separately revoke its Personal Pairing.
- Platform Account identity and metadata have no user-triggered deletion path in the first version, so the privacy notice and retention policy must state that limitation directly.
- Remote prompt and interaction operations can trigger tools with host filesystem and process access. Device authentication and end-to-end encryption do not replace the Session's tool and approval policy.
- A relay can still observe routing, presence, timing, and traffic size even under the accepted retention policy.
- Mobile hardware can protect the static storage of pairing key material where available, but standard Noise X25519 operations cannot be assumed to remain inside Secure Enclave or StrongBox; the native key adapter needs platform-specific proof and precise claims.
- A copied full pairing link grants the same short-lived opportunity as scanning its QR. Desktop confirmation and challenge expiry limit but do not erase that exposure.
- Theft of the simplified Desktop Relay credential can occupy or disconnect its route until rotation, although pairing-key authentication still protects application confidentiality and integrity.
- Supporting two adjacent Companion majors creates a standing compatibility and removal cost for every breaking protocol change.
- Multi-instance routing adds a shared connection directory and cross-instance forwarding path to the first pilot even though its user count is small.
- Rolling deploys may disconnect live sockets; the reconnect path must recover without duplicating a mutation or treating transport continuity as Session authority.
- Capacitor adapters for hardware-backed keys, encrypted storage, and local web assets require platform-specific proof before the container choice is irreversible.
- Ciphertext blob deletion depends on expiry and receipt processing; abandoned uploads and lost acknowledgements require deterministic cleanup.
- Without background delivery, a person must open or foreground Mobile Companion before learning current Desktop state.
- A mobile rollback outside its cache and pairing-key record compatibility may be unavailable; re-pairing is not an accepted normal upgrade path.
- The pilot delegates infrastructure backup and disaster recovery to Alibaba Cloud, so availability and recovery-point guarantees depend on the purchased service configuration rather than an application-owned controller.
- Requiring an open Desktop window makes remote availability intentionally fragile; restoring background availability later would require a new lifecycle decision.
- Sharing page components does not by itself establish mobile usability; assembled phone-sized interaction coverage remains required.
