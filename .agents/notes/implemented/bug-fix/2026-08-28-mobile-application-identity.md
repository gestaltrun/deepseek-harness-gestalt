# Agent Note: Correct the native Mobile application identity

Status: implemented

English | [中文](2026-08-28-mobile-application-identity.zh.md)

## Problem

The pre-release native projects and release environment used `com.alibaba.gestalt.mobile`, even though the application is distributed under the Gestalt product namespace. The application identifier also drifted independently from the `Gestalt` build product name and the `獭子哥` consumer name, so a release could validate display branding while signing the wrong application identity.

## Decision

`com.gestalt.mobile` is the sole iOS bundle identifier and Android application id. The Java package, protected-storage service names, provisioning-profile mapping, native project metadata, release environment, and signed-package checks use that identifier. Both release jobs receive `MOBILE_BUNDLE_ID` explicitly and reject any other value instead of allowing environment metadata to drift behind a script default.

Xcode `PRODUCT_NAME`, archive and package filenames, and CI artifact identifiers use `Gestalt`. The [consumer-brand decision](../feature/2026-08-28-tazige-mobile-brand.md) continues to own `獭子哥` as display copy and the approved otter as visual identity. The [native container decision](../architecture/2026-08-24-native-mobile-container-and-protected-authority.md) continues to own protected storage, signing isolation, and release authority.

## Alternatives considered

**Keep `com.alibaba.gestalt.mobile` because pre-release builds already used it.** Rejected because no App Store release or supported upgrade contract exists for those candidates, and the organizational namespace is not the approved product identity.

**Use the consumer name in the bundle identifier or build product.** Rejected because `獭子哥` is display copy, while reverse-domain identifiers and build artifacts require a stable technical name.

**Let each release script default the identifier without reading the Environment value.** Rejected because a correct default can hide stale release metadata and let the two platform jobs validate different inputs.

## Verification

Brand tests inspect every native identifier owner and require both release jobs to consume the same Environment variable. Android release verification checks the signed APK package name, version, and launcher label. iOS release verification checks the archive application identifier, build product name, display name, version, provisioning profile, and signature before export.

## Consequences

The identifier change creates a separate native Installation identity. Protected pairing state from `com.alibaba.gestalt.mobile` candidates is not migrated into `com.gestalt.mobile`; users pair the new installation again. A signed candidate cannot enter external Beta distribution unless its package metadata, provisioning profile, release environment, build identity, and consumer display identity agree.
