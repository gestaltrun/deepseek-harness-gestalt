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

apksigner_path="$(command -v apksigner || true)"
if [[ -z "${apksigner_path}" ]]; then
  sdk_roots=("${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}")
  local_properties="${mobile_root}/android/local.properties"
  if [[ -f "${local_properties}" ]]; then
    sdk_roots+=("$(sed -n 's/^sdk\.dir=//p' "${local_properties}" | head -n 1)")
  fi
  for sdk_root in "${sdk_roots[@]}"; do
    [[ -d "${sdk_root}/build-tools" ]] || continue
    while IFS= read -r candidate; do
      apksigner_path="${candidate}"
    done < <(find "${sdk_root}/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print | sort -V)
  done
fi
if [[ -z "${apksigner_path}" ]]; then
  echo 'Android SDK apksigner is unavailable' >&2
  exit 1
fi
"${apksigner_path}" verify --verbose "${target_apk}"
printf '%s\n' "${target_apk}"
