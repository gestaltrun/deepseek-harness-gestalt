# Agent Note: iOS Protected Storage Preserves the Empty Result Object

Status: implemented

English | [中文](2026-08-25-ios-protected-storage-empty-result.zh.md)

## Problem

The native protected-storage interface returns an object with an optional `value`. Android returned an empty object when no value existed, while iOS resolved the Capacitor call without a value. A fresh iOS installation therefore received `undefined`, and product startup failed before the signed-out account surface rendered.

## Decision

The iOS Keychain not-found branch resolves an empty dictionary. Both native implementations now preserve the shared `{ value?: string }` result type for missing values, allowing the JavaScript owner to create and persist the first Installation id.

## Alternatives considered

**Accept `undefined` in the JavaScript adapter.** Rejected because native bridges should implement one result type, and broadening the adapter would hide another native contract mismatch.

**Create the Installation id in native code.** Rejected because the shared JavaScript owner defines Installation creation and persistence semantics for both platforms.

## Consequences

Fresh iOS installations reach the account surface without weakening Keychain failure handling. Errors other than an absent item still reject explicitly.

## Testing

A source-level native-shell regression rejects a zero-argument resolution in the iOS not-found branch. The bundled production-configured application is built, installed on a fresh iOS Simulator, and must render the signed-out account surface.
