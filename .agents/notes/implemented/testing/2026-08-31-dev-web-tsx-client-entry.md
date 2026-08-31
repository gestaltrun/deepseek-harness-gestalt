# Agent Note: Explicit development client entries

Status: implemented

English | [中文](2026-08-31-dev-web-tsx-client-entry.zh.md)

## Problem

The shared client bundle preset selected `src/client/index.ts` for development watchers and `lib/types/client/index.js` for complete Client builds. A package whose source entry was TSX passed the complete build but failed only under `pnpm run dev:web`: tsdown returned its watcher bundles without completing their initial builds, so the HMR readiness barrier waited indefinitely.

## Decision

`clientBundle()` accepts an optional `clientSourceEntry` for the development face and retains `src/client/index.ts` as its default. The emitted Client build continues to consume `lib/types/client/index.js`. A package with a different source filename declares it at the package config call site; `ui-phone` declares `src/client/index.tsx`.

The HMR readiness barrier continues to require every tsdown bundle to complete its initial build. A missing or incorrect source entry remains a build failure instead of being hidden by a timeout increase or a partial-ready state.

## Alternatives considered

**Rename the TSX entry to `.ts`.** Rejected: the entry contains JSX and TypeScript requires the `.tsx` extension.

**Infer `.ts` versus `.tsx` from the filesystem.** Rejected: package build inputs stay explicit at the package boundary, and inference would delay a missing-entry diagnostic until startup.

**Relax the readiness barrier.** Rejected: starting Vite before every plugin bundle is current can serve stale browser artifacts and produce a false HMR pass.

## Consequences

Development watchers and complete Client builds may use different physical entry filenames while preserving one package-owned declaration. New packages keep the default unless their source entry differs. The preset test checks both the declared development entry and the fixed emitted entry.

## Verification

The client bundle preset test covers the `ui-phone` TSX declaration. The real HMR browser E2E must reach `dev-web: watching`, edit a client source file, observe the updated page without reload, and restore its owned source and build artifacts.
