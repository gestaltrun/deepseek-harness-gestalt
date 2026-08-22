# `@deepseek-ai/dsh-platform-account`

English | [中文](README.zh.md)

Service Definition for Platform Account identity and the Account Session bound to one Desktop or Mobile Installation. `AccountService` owns Login Attempt creation, GitHub callback completion, signed polling, access-token refresh, current-account reads, authenticated current-installation reads, current-installation sign-out, and connection tracking through `ctx.platformAccount`. `currentInstallation()` returns the provider-bound Installation id and kind with the Account projection, so another capability never needs Account tables or caller-supplied role claims.

The public types brand Account, Login Attempt, Account Session, Installation, and proof-JTI ids. Runtime `AccountError` exposes stable failure codes for invalid or expired attempts, invalid or replayed proof, expired or revoked sessions, and open-registration `QUOTA` / `PLATFORM_CAPACITY` failures that carry `retryAfter` in seconds; the `./types` subpath remains type-only. Spec-fixed ceilings are ten live Desktop installations, ten live Mobile installations, and twenty concurrent tracked connections per Account. An optional shared `PlatformCapacityState` sheds new login while established sessions remain usable.

`loadOperatedPlatformEnvironment` is the product-entry parser: it accepts one complete production identity and rejects local origins. `loadPlatformEnvironment` validates and selects a development/production pair only for bounded compositions such as examples and tests. Product clients supply the operated identity through deployment-owned build artifacts and have no runtime development selector.

## Model Experience

None, as Platform Account state adds no messages, tools, or prompt text.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Account deletion, session lists, remote sign-out, sign-out-all, recovery, and identity linking are not part of this service.
- Personal Pairings are a separate capability and are never deleted by `signOut`.
