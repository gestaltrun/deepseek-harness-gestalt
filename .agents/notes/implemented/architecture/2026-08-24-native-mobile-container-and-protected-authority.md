# Agent Note: Ship native Mobile authority from checked-in Capacitor projects

Status: implemented

English | [中文](2026-08-24-native-mobile-container-and-protected-authority.zh.md)

## Problem

The [Mobile Companion proposal](../../proposed/feature/2026-08-17-mobile-companion.md) selected a thin native container, protected pairing keys, encrypted offline content, application links, and controlled distribution, but the product directory contained only Web source. The operated entry persisted Installation identity and pairing authority through browser storage, left Companion Cache disconnected, and had no reproducible App Store or release-key Android artifact path. A successful Web build therefore could not establish native storage, upgrade, lifecycle, picker, signing, or packaged-entry behavior.

## Decision

`apps/mobile/ios` and `apps/mobile/android` are checked-in Capacitor projects for `com.alibaba.gestalt.mobile`. Capacitor copies the compiled `apps/mobile/src/main.tsx` closure into each application; neither project loads executable application code from Desktop, Platform, Vite, or `prototype-companion`. Both native projects register `GestaltProtectedStorage`. iOS stores UTF-8 values as generic-password Keychain entries with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Android creates a non-exportable AES-GCM key in Android Keystore, binds each encrypted SharedPreferences value to its storage key as additional authenticated data, uses a fresh system IV for every replacement, and disables application backup. Product composition requires this native plugin and stores the stable Installation id, Mobile Relay grant, 96-byte IK reconnect record, attachment key, and pending pairing recovery there. IndexedDB pairing storage remains an injectable browser test adapter and cannot be selected by the bundled entry.

The authenticated Account and Personal Pairing select one account-scoped Companion Cache database. An HKDF-SHA-256 key derived from the pairing-owned attachment material encrypts one versioned Workspace, Session, and transcript projection snapshot with pairing-specific AES-GCM additional data. Only a complete validated cached projection becomes read-only Remote Offline presentation; it cannot create an authenticated connection or enable a mutation. A real authenticated projection replaces it, seals a new cache snapshot, and remains Desktop authority. Clearing one Desktop's cache deletes its content and receipts without deleting protected pairing authority. Session creation, prompts, cancellation, interaction settlement, and attachment offers store Operation Receipts after transmission. Foreground reconnect queries each unknown operation id against the pairing-scoped Desktop ledger, applies its original result or explicit absence, refreshes presentation, and never replays the mutation.

The native shells declare camera access and use WebView file input for the operating-system document picker. `@capacitor/app` owns foreground/background lifecycle and `appUrlOpen`. A `deepseek-gestalt://pair?link=...` URL carries only the existing complete one-time pairing link into the same parser as paste and QR; OAuth credentials and Account callback values never use the application scheme.

The `mobile-release` Environment supplies one version/build identity, production public configuration, the Android release keystore, and Apple upload credentials. Android release builds decode the keystore only into a mode-0600 temporary directory, verify the signed APK, and delete the temporary copy. iOS release builds run on the protected self-hosted macOS ARM64 runner, reject a missing Distribution identity or an expired/mismatched `Gestalt Mobile App Store` profile, archive under team `MUX3KT56Q6`, and export with an explicit App Store profile mapping. TestFlight upload is a separate dispatch-controlled step. Build artifacts, profiles, keystores, and credentials are ignored and never committed.

## Alternatives considered

**Keep pairing authority in IndexedDB because the WebView origin is stable.** Rejected because a stable origin does not provide the native protected-storage requirement or prevent ordinary Web content storage from owning long-lived Relay and reconnect authority.

**Adopt a generic secure-storage Capacitor plugin.** Rejected because the available plugin contracts add migration and backup behavior that this release does not need, while the required operation is a small string key-value interface with explicit iOS accessibility, Android authenticated encryption, and deletion semantics.

**Generate iOS and Android projects only during a release job.** Rejected because signing settings, permissions, custom plugins, application links, and native upgrade behavior would not be reviewable source and generator drift could change the candidate after code review.

**Sign iOS on an ordinary GitHub-hosted runner.** Rejected because the approved Environment has Apple upload credentials but no exportable signing certificate or provisioning-profile secret. The controlled self-hosted runner already owns the non-exportable Distribution identity and installed App Store profile; preflight binds the workflow to those exact assets.

## Consequences

Application upgrades preserve Installation and pairing authority when the operating system preserves Keychain or Android application data, while cache corruption or format replacement can be handled by clearing disposable encrypted rows without normal re-pairing. Android uninstall removes application data and creates a new Installation after reinstall. iOS Keychain data can survive uninstall, so reinstall preserves the Installation until iOS or the user removes that Keychain item. Simulator and emulator builds validate native integration but do not claim physical-device hardware-backed key properties.

The checked-in projects and scripts make a signed candidate reproducible, but artifact creation is not assembled product acceptance. TestFlight and signed APK evidence must name the exact reviewed commit and operated Platform/Desktop run; a locally exported intermediate IPA, Vite origin, or prototype remains insufficient.
