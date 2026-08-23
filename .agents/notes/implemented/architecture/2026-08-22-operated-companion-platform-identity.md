# Agent Note: Bind Companion products to one operated Platform identity

Status: implemented

English | [中文](2026-08-22-operated-companion-platform-identity.zh.md)

## Problem

Desktop and Mobile product entries could select a development identity pair and keyless Remote Access path, while the Platform listen entry supplied a dummy second identity and accepted storage defaults or disabled certificate verification. A local Account provider or in-memory authority could therefore look like the product even though it did not use the operated identity or shared durable stores.

## Decision

Desktop, Mobile, and Platform listen entries accept one complete production identity. `loadOperatedPlatformEnvironment` rejects missing fields, non-HTTPS or callback-mismatched values, and localhost before a product entry reads state, renders, opens a window, connects a store, or sends traffic. Desktop packaging rejects unknown input fields and reconstructs `operated-platform.json` from the `production` marker plus the six public identity fields, so Finder and shortcut launches do not depend on a shell environment; exactly those six selected caller fields enter the artifact, while unknown or unselected caller fields cannot. Mobile receives the same fields through its build. Desktop and Mobile expose no development or keyless selector. Deterministic keyless code lives under named test fixtures and cannot be reached through their product import graphs.

Platform Environment `production` supplies the GitHub OAuth client id, fixed callback, credential reference and resolved secret, PostgreSQL database identity, identity namespace, Redis ACL identity, and Relay Redis key prefix. Desktop packages contain only the public fields and credential reference, never the resolved OAuth secret. The listen entry calls the entry-owned `launchOperatedPlatform` composition and has no dummy pair or fallback identity. It validates the complete listen host and port before resource acquisition. Redis clients are acquired transactionally: each active client retains an error listener, a failed connection destroys its client, and every failure or close removes the listener; a failure during the second acquisition closes the first client and PostgreSQL pool. Teardown uses the maintained Redis `close()` operation, destroys the client only when a rejected close leaves it open, and preserves the close failure together with any cleanup failure in an `AggregateError`. PostgreSQL and Redis certificate verification is mandatory. `OperatedRemoteAccessResources` owns the PostgreSQL Personal Pairing authority and Relay route stores together with the Redis Relay coordinator; migrations run before listen. Pairing HTTP and Relay WSS remain fail-closed until the reviewed Companion channel provider is composed.

The `verify-companion-product-entry` script follows relative imports and selected bare workspace package exports from all three product entries, including star re-exports, local import/export aliases, and cyclic barrels. It rejects fixed GitHub fixture identity, keyless providers, in-memory authorities, generic environment selection, proof-only examples, development trust origins, and disabled certificate checks. The assembled durable-resource test starts disposable PostgreSQL and Redis fixtures and drives `launchOperatedPlatform`, including environment parsing, GitHub OAuth, Account persistence, Personal Pairing authority, and Relay coordination. A spawned entry test sends `SIGTERM` to the real source executable and verifies that HTTP, PostgreSQL, and Redis owners close before a normal process exit. These tests are not evidence that the operated deployment in #43 is live.

## Alternatives considered

**Keep a validated development/production pair in product clients.** Rejected because one unused identity still preserves arbitrary endpoint selection and makes local proof configuration resemble a supported product environment.

**Keep keyless providers in product source behind environment checks.** Rejected because runtime checks leave the proof implementation reachable from shipped entry graphs and make a packaging mistake a security decision.

**Allow local TLS exceptions for Platform stores.** Rejected because a deployment setting that disables certificate verification changes the product trust model. Test fixtures inject their own non-TLS clients without entering product configuration.

## Consequences

Incomplete or local product configuration stops startup instead of projecting an unavailable Account after other product work begins. Release and deployment workflows must supply every public identity and credential reference explicitly. Local tests retain deterministic fakes, but their names and locations prevent them from being cited as product behavior. The repository proves durable adapter assembly; #43 still owns live operated infrastructure evidence, and the reviewed encrypted channel remains a separate dependency.
