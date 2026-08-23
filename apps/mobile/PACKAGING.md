# Mobile release packaging

This reference covers the checked-in Capacitor projects. It produces artifacts from bundled `apps/mobile/src/main.tsx`; a Vite page or `prototype-companion` is not a release input.

## Configuration

Both scripts require the production `VITE_PLATFORM_*` and `VITE_REMOTE_RELAY_*` variables listed in [README.md](README.md). Release identity comes from the `mobile-release` GitHub Environment: application id `com.alibaba.gestalt.mobile`, Apple team `MUX3KT56Q6`, version/build variables, Android keystore secrets, and Apple upload credentials. Profiles, certificates, keystores, passwords, and `.ipa`/`.apk` artifacts stay outside git.

## Android

`scripts/build-android-release.sh` decodes `ANDROID_KEYSTORE_BASE64` into a mode-0600 temporary file, builds the bundled Web entry, runs Capacitor sync, assembles Release with `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`, verifies the APK signature, then removes the temporary keystore.

```sh
MOBILE_VERSION=0.1.0 MOBILE_BUILD_NUMBER=3 \
  bash apps/mobile/scripts/build-android-release.sh
```

The artifact is written under the ignored `apps/mobile/release/` directory.

## iOS and TestFlight

`scripts/build-ios-release.sh` fails before building unless the selected macOS runner has a valid Distribution identity for team `MUX3KT56Q6` and a non-expired `Gestalt Mobile App Store` profile authorizing `MUX3KT56Q6.com.alibaba.gestalt.mobile`. It archives version/build from the Environment and exports with `ios/AppStoreExportOptions.plist`.

```sh
MOBILE_VERSION=0.1.0 MOBILE_BUILD_NUMBER=3 APPLE_TEAM_ID=MUX3KT56Q6 \
  bash apps/mobile/scripts/build-ios-release.sh
```

Upload is a separate mutation. `scripts/upload-testflight.sh` requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and the exact `IPA_PATH`. `.github/workflows/mobile-release.yml` runs only from `master`, checks out the required `candidate_sha`, rejects it unless it is the exact current remote `master`, and uses the protected `mobile-release` Environment. iOS additionally requires the dedicated `mobile-release` self-hosted macOS ARM64 runner label and uploads only when `upload_testflight` is true.
