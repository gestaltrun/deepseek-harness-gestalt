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

`scripts/build-ios-release.sh` fails before building unless the selected macOS runner has a valid Distribution identity for team `MUX3KT56Q6` and a non-expired `Gestalt Mobile App Store` profile authorizing `MUX3KT56Q6.com.alibaba.gestalt.mobile`. Profile expiration uses the profile's UTC raw date, independent of the runner locale and time zone. It archives version/build from the Environment, verifies the archived application's iPhone and iPad orientation lists, and exports with `ios/AppStoreExportOptions.plist`. The universal bundle remains portrait on iPhone and declares all four iPad orientations required for multitasking validation.

```sh
MOBILE_VERSION=0.1.0 MOBILE_BUILD_NUMBER=3 APPLE_TEAM_ID=MUX3KT56Q6 \
  bash apps/mobile/scripts/build-ios-release.sh
```

Upload is a separate mutation. `scripts/upload-testflight.sh` requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and the exact `IPA_PATH`. The workflow keeps the app-specific password in the upload step environment, and the script gives `altool` the `@env:APPLE_APP_SPECIFIC_PASSWORD` reference so the credential value is absent from process arguments. A credential observed in a process listing or diagnostic output must be revoked and replaced before another upload. `.github/workflows/mobile-release.yml` runs only from `master`, checks out the required `candidate_sha`, rejects it unless it is the exact current remote `master`, and uses the protected `mobile-release` Environment. iOS additionally requires the dedicated `mobile-release` self-hosted macOS ARM64 runner label and uploads only when `upload_testflight` is true.

## Candidate acceptance and signing

Operated acceptance is recorded only after the bundled product entry passes GitHub login, Account, complete-link Personal Pairing, Session navigation, search, creation, interaction, attachment, cache, upgrade, failure, and phone-size UI checks. Camera scanning remains a supported product flow but is outside the controlled release evidence. Approved native Android Emulators and iOS Simulators satisfy device evidence; `prototype-companion` and ports 5173/5174 do not. Dispatch `Mobile Companion Acceptance` against the exact tested `master` SHA with evidence JSON containing each value from `COMPANION_RELEASE_FLOWS`, every platform/check pair derived from `COMPANION_RELEASE_PLATFORMS` and `COMPANION_RELEASE_DEVICE_CHECKS`, and all four booleans below set to `true`:

```json
{
  "flows": ["github-login", "account", "link-pairing", "desktop-navigation", "search", "workspace-create", "ungrouped-create", "prompt", "cancel", "approval", "question", "attachment", "cache"],
  "devices": ["ios:protected-key-storage", "ios:encrypted-cache", "ios:file-selection", "ios:foreground-lifecycle", "android:protected-key-storage", "android:encrypted-cache", "android:file-selection", "android:foreground-lifecycle"],
  "upgradePreservedKeys": true,
  "uiAcceptance": true,
  "failureAcceptance": true,
  "transportRiskAccepted": true
}
```

The successful verdict uploads `mobile-companion-acceptance-<candidate_sha>`. Dispatch `Mobile Release` with that exact `candidate_sha`, the acceptance run id, and explicit transport-risk acceptance. The authorization job requires the source run to belong to `.github/workflows/mobile-companion-acceptance.yml`, then verifies its event, successful named verdict, unique unexpired artifact, repository, run id, commit, Git tree, exact evidence vocabulary, and distribution approval before either signing job receives its Environment or secrets.
