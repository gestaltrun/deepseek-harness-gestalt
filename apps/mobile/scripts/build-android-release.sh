#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile_root="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${mobile_root}/../.." && pwd)"

: "${ANDROID_KEYSTORE_BASE64:?ANDROID_KEYSTORE_BASE64 is required}"
: "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is required}"
: "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is required}"
: "${ANDROID_KEY_PASSWORD:?ANDROID_KEY_PASSWORD is required}"
: "${MOBILE_VERSION:?MOBILE_VERSION is required}"
: "${MOBILE_BUILD_NUMBER:?MOBILE_BUILD_NUMBER is required}"

release_dir="${mobile_root}/release"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "${temporary_dir}"' EXIT
keystore="${temporary_dir}/mobile-release.jks"
printf '%s' "${ANDROID_KEYSTORE_BASE64}" | base64 --decode > "${keystore}" 2>/dev/null \
  || printf '%s' "${ANDROID_KEYSTORE_BASE64}" | base64 -D > "${keystore}"
chmod 600 "${keystore}"

cd "${repo_root}"
pnpm --filter @deepseek-ai/dsh-mobile run build
pnpm --dir apps/mobile exec cap sync android

cd "${mobile_root}/android"
ANDROID_KEYSTORE_FILE="${keystore}" ./gradlew --no-daemon :app:assembleRelease \
  -Pandroid.injected.version.code="${MOBILE_BUILD_NUMBER}" \
  -Pandroid.injected.version.name="${MOBILE_VERSION}"

source_apk="${mobile_root}/android/app/build/outputs/apk/release/app-release.apk"
test -f "${source_apk}"
mkdir -p "${release_dir}"
target_apk="${release_dir}/DeepSeek-Gestalt-${MOBILE_VERSION}-${MOBILE_BUILD_NUMBER}.apk"
cp "${source_apk}" "${target_apk}"

if command -v apksigner >/dev/null 2>&1; then
  apksigner verify --verbose "${target_apk}"
else
  jarsigner -verify -strict "${target_apk}"
fi
printf '%s\n' "${target_apk}"
