# Agent Note: Instantiate the iOS Protected-Storage Bridge Controller

Status: implemented

English | [中文](2026-08-25-ios-storyboard-registers-protected-storage.zh.md)

## Problem

The iOS storyboard instantiated Capacitor's generic `CAPBridgeViewController`. The application-specific `GestaltBridgeViewController.capacitorDidLoad()` hook therefore never ran, `GestaltProtectedStorage` was not registered, and JavaScript startup waited indefinitely for the first protected Installation id read. The Simulator displayed a blank WebView even though the native application and bundled assets launched.

## Decision

`Main.storyboard` instantiates `GestaltBridgeViewController` from the `App` module. That controller remains the single iOS registration owner for `GestaltProtectedStorage`; the JavaScript entry continues to require the plugin and does not fall back to unprotected browser storage.

Simulator builds use normal local ad-hoc signing when exercising Keychain. Disabling code signing is not valid protected-storage evidence because the unsigned process cannot establish the application Keychain entitlement context.

## Alternatives considered

**Register the plugin from JavaScript.** Rejected because Capacitor native plugin registration belongs to the native bridge lifecycle, and JavaScript cannot create the missing Swift implementation.

**Fall back to IndexedDB when the plugin is absent.** Rejected because the shipped native entry requires operating-system protected Installation and pairing authority; a browser fallback would silently change the product security state.

**Keep the generic controller and add another storyboard callback.** Rejected because the existing application controller already owns Capacitor registration and gives the storyboard one explicit root-controller identity.

## Consequences

A fresh signed iOS Simulator installation registers protected storage before the Web entry requests its Installation id and reaches the Account surface. A missing native plugin still fails closed. Storyboard class and module names become release-critical native wiring and are checked as source, not inferred from a successful Xcode compile.

## Testing

The release regression requires `Main.storyboard` to name `GestaltBridgeViewController` and the `App` module and rejects the generic Capacitor controller. A clean signed Simulator build returns Keychain results and renders the real privacy and GitHub login flow from bundled Mobile assets.
