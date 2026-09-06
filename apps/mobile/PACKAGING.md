# Mobile release packaging

This reference covers the checked-in Capacitor projects. It produces artifacts from bundled `apps/mobile/src/main.tsx`; a Vite page or `prototype-companion` is not a release input.

## Configuration

Both scripts require the production `VITE_PLATFORM_*` and `VITE_REMOTE_RELAY_*` variables listed in [README.md](README.md). Release identity comes from reviewed source: `apps/mobile/package.json` owns the Marketing Version, `release.json` owns the monotonic build number, and the workflow projects both values into the scripts. The `mobile-release` GitHub Environment owns application id `com.gestalt.mobile`, Apple team `MUX3KT56Q6`, Android keystore secrets, and Apple upload credentials. The scripts reject another application id before signing. Profiles, certificates, keystores, passwords, and `.ipa`/`.apk` artifacts stay outside git. The cross-product plan and approval flow is defined in [Product releases](../../docs/product-releases.md).

## Android

`scripts/build-android-release.sh` decodes `ANDROID_KEYSTORE_BASE64` into a mode-0600 temporary file, builds the bundled Web entry, runs Capacitor sync, assembles Release with `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`, verifies the APK signature, then removes the temporary keystore. Android System WebView 83 is the release floor. Candidate acceptance launches the bundled entry on that runtime and requires either the operated account surface or the bilingual startup diagnostic; an empty WebView is a failure.

```sh
MOBILE_VERSION=0.1.0 MOBILE_BUILD_NUMBER=3 \
  bash apps/mobile/scripts/build-android-release.sh
```

The artifact is written under the ignored `apps/mobile/release/` directory.

## iOS and TestFlight

`scripts/build-ios-release.sh` fails before building unless the selected macOS runner has a valid Distribution identity for team `MUX3KT56Q6` and a non-expired `Gestalt Mobile App Store com.gestalt.mobile` profile authorizing `MUX3KT56Q6.com.gestalt.mobile`. Profile expiration uses the profile's UTC raw date, independent of the runner locale and time zone. It archives the source-projected version/build, verifies the archived application's iPhone and iPad orientation lists, and exports with `ios/AppStoreExportOptions.plist`. The universal bundle remains portrait on iPhone and declares all four iPad orientations required for multitasking validation.

```sh
MOBILE_VERSION=0.1.0 MOBILE_BUILD_NUMBER=3 APPLE_TEAM_ID=MUX3KT56Q6 \
  bash apps/mobile/scripts/build-ios-release.sh
```

Upload is a separate mutation. `scripts/upload-testflight.sh` requires `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and the exact `IPA_PATH`. The workflow keeps the app-specific password in the upload step environment, and the script gives `altool` the `@env:APPLE_APP_SPECIFIC_PASSWORD` reference so the credential value is absent from process arguments. A credential observed in a process listing or diagnostic output must be revoked and replaced before another upload. `.github/workflows/mobile-release.yml` checks out the required full `candidate_sha`, verifies the plan-selected version and build against that checkout, and uses the protected `mobile-release` Environment. The same plan remains retryable after `master` advances. iOS additionally requires the dedicated `mobile-release` self-hosted macOS ARM64 runner label and uploads only when `upload_testflight` is true.

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

Before operated acceptance, `Mobile Release` may run with `candidate_build_only=true` only for the exact current `master` plan candidate and explicit candidate-scoped transport-risk acceptance. This mode uses the protected `mobile-release` Environment to build one release-signed Android APK, uploads it only as the repository-accessible `mobile-acceptance-candidate-<candidate_sha>` Actions artifact, and records the candidate, plan, version, build, APK digest, signer-certificate digest, and operated-origin digest. It rejects an acceptance run id, artifact recovery, TestFlight upload, and GitHub publication. The artifact is physical-acceptance input, not Mobile Release acceptance or publication evidence, and it is absent from the recovery producer allowlist.

The successful verdict uploads `mobile-companion-acceptance-<candidate_sha>`. The coordinator passes that exact candidate, plan path, plan version, plan build, acceptance run id, explicit transport-risk acceptance, and GitHub publication choice. The authorization job requires the source run to belong to `.github/workflows/mobile-companion-acceptance.yml`, then verifies its event, successful named verdict, unique unexpired artifact, repository, run id, commit, Git tree, exact evidence vocabulary, and distribution approval before either ordinary signing job receives its Environment or secrets. After both native jobs succeed, publication creates a draft `mobile-v<version>` prerelease, uploads the signed APK plus `SHA256SUMS`, downloads and verifies the same assets, then publishes; the IPA remains protected evidence and the public TestFlight link is the iOS installation channel. A manual publication retry supplies the prior `artifact_run_id` and never invokes either signing job again.
