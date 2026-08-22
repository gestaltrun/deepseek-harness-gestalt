# Agent Note: GitHub Platform Account and installation sessions

Status: implemented

English | [中文](2026-08-17-platform-account-installation-sessions.zh.md)

## Problem

Desktop and Mobile need one Platform identity before Personal Pairing and Remote Access can authorize work. A GitHub browser login by itself does not define which provider fields Platform retains, how an app safely receives the result, how concurrent Platform processes agree that an installation signed out, or whether switching Accounts can expose pairing keys and receipts from the previous Account.

The two installation forms also have different trusted storage. Mobile WebCrypto can persist a non-exported key under a stable WebView origin. Desktop's renderer origin follows its loopback Web Host, so renderer storage cannot own a stable private key across launches.

## Decision

`@deepseek-ai/dsh-platform-account` is the Service Definition for Platform Account and the current Installation's Account Session. The core provider stores the immutable numeric GitHub id in an environment identity namespace and refreshes only public login and avatar. Its OAuth App request uses random state and S256 PKCE without a scope parameter; a non-empty returned scope is rejected, and the GitHub token is discarded after `/user` returns the public identity.

An Installation starts a five-minute Login Attempt. GitHub returns to one fixed HTTPS Platform callback. The app receives no OAuth code or provider token: it polls with a signed, single-use attempt token and a fresh P-256 proof. Successful polling creates one Account Session for the Installation and replaces any earlier session for that Installation. Access tokens last 15 minutes; refresh tokens rotate on each accepted use and expire after at most 30 days. A refresh is rejected before proof consumption or rotation unless a complete 15-minute access lifetime fits inside that absolute expiry. Current-account reads, refresh, and sign-out require a timestamped, replay-protected proof whose JTI is branded and parsed at the wire or random-source boundary.

The Account provider commits revocation before awaiting publication of the Account Session id through `AccountInvalidationBus`. Publication contains synchronous throws and asynchronous rejections per subscriber, and every Platform Instance likewise runs every connection closer before reporting an aggregate failure. Sign-out clears only the current Installation's authorization. Personal Pairings and account-scoped material remain in namespaces that include environment and Account id; switching Accounts selects another namespace instead of overwriting or sharing the previous one.

Desktop Host owns its private key, session tokens, Electron `shell.openExternal` invocation, and `safeStorage`-encrypted environment file. The file uses random exclusive atomic-write siblings and an owner-only rename commit. The renderer receives only an Account snapshot and lifecycle verbs through preload. Desktop presents Account state only in the `手机配对` Settings section; the normal sidebar and Session interaction remain unchanged. Desktop shutdown closes and drains the lifecycle transition owner; an in-flight poll cannot mutate storage or publish after disposal. Mobile owns a non-exported WebCrypto key in IndexedDB, whose parser requires genuine `CryptoKey` identity plus private P-256 ECDSA signing properties, and the composition includes an `@capacitor/browser` adapter. The attempt is prepared before the authorization button becomes active, so its click directly invokes the native browser API without popup or custom-URL fallback. Both presentations import the same Chinese and English retention notice before authorization and state that the first version has no account deletion. Their snapshot dispatchers contain each listener independently and report aggregated failures only after later listeners run.

Development and production use different HTTPS origins, fixed callbacks, GitHub OAuth Apps, credential references, database identities, and identity namespaces. Generic capability examples can validate the complete pair, while Desktop and Mobile products accept only the operated production identity before rendering or traffic. Desktop reads release-projected public fields from its application archive; Mobile receives the same identity through its build. The operated value binds the HTTP Consumer's one required CORS origin, client transport, OAuth adapter, backend database identity, local store, callback, and issued identity namespace. HTTP responses, IndexedDB records, and Desktop encrypted files have explicit parsers. One lifecycle transition owner serializes load, login, polling, refresh, Account switching, and sign-out.

## Alternatives considered

**Redirect an OAuth code or token to a custom application URL.** This makes an application handler a credential transport and complicates replay and installation binding. Signed polling keeps the provider callback and credentials on Platform.

**Use a GitHub token as the Platform session.** Provider-token lifetime, scope inheritance, and revocation would become Platform authorization semantics. The separate proof-of-possession session lets Platform retain only public identity and revoke one Installation independently.

**Store the Desktop key in renderer IndexedDB.** The Desktop Web Host uses a loopback URL whose port can change. Electron Host storage gives the installation a stable owner and keeps signing material outside web content.

**Delete Pairings on sign-out or Account switch.** Sign-out would become destructive and would conflate identity authorization with the independent Personal Pairing relationship. Account-scoped namespaces preserve material without making it visible to another Account.

**Share development and production identity infrastructure.** A client or credential mistake could authenticate or persist into the other environment. Distinct identities make cross-environment acceptance fail before runtime traffic.

## Consequences

Platform deployment must supply atomic Account persistence, distributed invalidation, OAuth credentials, signing keys, audit retention, and HTTPS edge behavior. The operated listen process and product clients accept only production; [production-only release CI](../process/2026-08-20-platform-production-release-ci.md) owns the server restriction, while Desktop and Mobile packaging project the public operated identity into shipped artifacts. Spec-fixed open-registration installation and connection ceilings live in the Account provider ([open-registration quotas](2026-08-19-open-registration-quotas-capacity.md)). The in-memory backend and bus are fixture adapters, not production durability. Native Mobile packaging must supply a stable WebView origin; the Mobile composition owns its Capacitor Browser adapter. Account deletion, session lists, remote sign-out, sign-out-all, recovery, identity linking, Personal Pairing, and Remote Access remain separate capabilities.

## Testing

Core tests cover PKCE/no-scope authorization, single-use polling, exact expiry and last-full-access-window boundaries, proof replay, refresh rotation without late state mutation, complete environment binding, callback state, asynchronous invalidation containment, and cross-instance connection closure. Installation tests cover privacy gating, serialized duplicate restoration and refresh/sign-out, listener containment, branded proof ids, explicit HTTP and durable parsers, genuine-versus-shaped `CryptoKey` records, Account namespace isolation, and sign-out preservation. Mobile entry coverage uses the real composition through the Capacitor Browser adapter boundary and resolves the privacy subpath from source on a clean tree; Desktop coverage includes quiescent in-flight-poll disposal plus symlink replacement, failure cleanup, and concurrent atomic writes. A Loader test mounts the real WebServer, Account provider, HTTP Consumer, client transport, and TCP server for required selected-origin binding, P-256 headers, JSON parsing, rotation, polling, and cross-instance sign-out. The `examples/platform-account/cordis.yml` Loader snapshot records the 15-minute/30-day lifecycle and cross-instance sign-out. [Assembled GitHub sign-in acceptance](2026-08-19-github-signin-assembled-acceptance.md) records two-installation Loader HTTP sign-in, pairing-key and receipt isolation after an Account switch, same-signing-key identity-namespace rejection, and the Desktop Host lifecycle over TCP.
