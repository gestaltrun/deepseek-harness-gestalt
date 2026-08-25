# Agent Note: Package Desktop ESM Runtime Dependencies for Electron

Status: implemented

English | [中文](2026-08-25-packaged-desktop-esm-runtime-dependencies.zh.md)

## Problem

The packaged Desktop main process is an ESM bundle. Bundling the CommonJS `ws` package copied its dynamic Node built-in requires into that bundle, where the generated ESM require shim rejected them before Desktop logging, the Account controller, or the Web Host could start. The packaged smoke also replaced the macOS login home, which made Electron `safeStorage` unavailable despite a valid user Keychain, and searched immediately after prompt admission while the accepted turn was still writing its authoritative Session log.

## Decision

The Desktop main build keeps `ws` external and declares it as a direct runtime dependency beside the existing Electron externals. The Desktop Knip workspace records that packaging-owned dependency because the generated external import is not present in the TypeScript source graph. The packaged smoke isolates `DSH_HOME` and Electron userData on every platform, but retains the logged-in macOS home so `safeStorage` uses the login Keychain. Smoke acceptance waits for the authoritative `turn/end` event before exercising Session search, and production-configured pairing reports `ready`.

## Alternatives considered

**Inject a generic `createRequire` shim into the ESM bundle.** Rejected because it would conceal which CommonJS package requires Node runtime loading and make every bundled dynamic require part of the Desktop loader policy.

**Add a plaintext or test-only protected-storage fallback.** Rejected because packaged acceptance exercises Electron `safeStorage` with the same failure behavior as the installed product.

**Add a fixed delay or retry the search result.** Rejected because prompt admission does not establish turn completion; the Session log's `turn/end` event is the authoritative lifecycle fact.

## Consequences

The packaged application loads `ws` from its installed runtime dependencies instead of evaluating CommonJS source inside the ESM bundle. macOS packaged tests retain Keychain access without reusing application state, while other platforms keep a temporary home. The smoke reaches Account, Pairing, Web Host, Companion prompt, SQLite search, Relay teardown, and quit only after their authoritative prerequisites are visible.

## Testing

The bundle regression requires an external `ws` import, rejects bundled `ws` source, and requires the direct runtime dependency. The production-configured macOS arm64 package smoke starts the installed bundle with no runtime Platform or Relay variables, waits for `turn/end`, verifies search hit and miss results, and completes the Relay lifecycle and shutdown checks.
