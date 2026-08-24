#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile_root="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${mobile_root}/../.." && pwd)"

: "${MOBILE_VERSION:?MOBILE_VERSION is required}"
: "${MOBILE_BUILD_NUMBER:?MOBILE_BUILD_NUMBER is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

bundle_id="${MOBILE_BUNDLE_ID:-com.alibaba.gestalt.mobile}"
profile_name="${MOBILE_PROVISIONING_PROFILE:-Gestalt Mobile App Store}"
release_dir="${mobile_root}/release"
archive="${release_dir}/DeepSeek-Gestalt.xcarchive"
export_dir="${release_dir}/ios-export"
profile_plist="$(mktemp)"
trap 'rm -f "${profile_plist}"' EXIT

if ! security find-identity -v -p codesigning \
  | grep -E 'Apple Distribution|iPhone Distribution' \
  | grep -Fq "(${APPLE_TEAM_ID})"; then
  echo "Apple Distribution identity for team ${APPLE_TEAM_ID} is unavailable" >&2
  exit 1
fi

profile_path="${MOBILE_PROVISIONING_PROFILE_PATH:-}"
if [[ -z "${profile_path}" ]]; then
  for profile_directory in \
    "${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles" \
    "${HOME}/Library/MobileDevice/Provisioning Profiles"; do
    [[ -d "${profile_directory}" ]] || continue
    while IFS= read -r candidate; do
      if security cms -D -i "${candidate}" > "${profile_plist}" 2>/dev/null \
        && [[ "$(/usr/libexec/PlistBuddy -c 'Print :Name' "${profile_plist}" 2>/dev/null)" == "${profile_name}" ]]; then
        profile_path="${candidate}"
        break 2
      fi
    done < <(find "${profile_directory}" -maxdepth 1 -name '*.mobileprovision' -type f -print)
  done
fi
if [[ -z "${profile_path}" || ! -f "${profile_path}" ]]; then
  echo "Provisioning profile '${profile_name}' is unavailable" >&2
  exit 1
fi
security cms -D -i "${profile_path}" > "${profile_plist}"
profile_application_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "${profile_plist}")"
profile_expiration="$(/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "${profile_plist}")"
if [[ "${profile_application_id}" != "${APPLE_TEAM_ID}.${bundle_id}" ]]; then
  echo "Provisioning profile does not authorize ${APPLE_TEAM_ID}.${bundle_id}" >&2
  exit 1
fi
if [[ "$(date -j -f '%a %b %d %T %Z %Y' "${profile_expiration}" '+%s')" -le "$(date '+%s')" ]]; then
  echo "Provisioning profile '${profile_name}' is expired" >&2
  exit 1
fi

cd "${repo_root}"
pnpm --filter @deepseek-ai/dsh-mobile run build
pnpm --dir apps/mobile exec cap sync ios

rm -rf "${archive}" "${export_dir}"
mkdir -p "${release_dir}"
xcodebuild \
  -project "${mobile_root}/ios/App/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "${archive}" \
  DEVELOPMENT_TEAM="${APPLE_TEAM_ID}" \
  PRODUCT_BUNDLE_IDENTIFIER="${bundle_id}" \
  MARKETING_VERSION="${MOBILE_VERSION}" \
  CURRENT_PROJECT_VERSION="${MOBILE_BUILD_NUMBER}" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY='Apple Distribution' \
  PROVISIONING_PROFILE_SPECIFIER="${profile_name}" \
  archive

xcodebuild -exportArchive \
  -archivePath "${archive}" \
  -exportOptionsPlist "${mobile_root}/ios/AppStoreExportOptions.plist" \
  -exportPath "${export_dir}"

source_ipa="$(find "${export_dir}" -maxdepth 1 -name '*.ipa' -print -quit)"
test -n "${source_ipa}"
target_ipa="${release_dir}/DeepSeek-Gestalt-${MOBILE_VERSION}-${MOBILE_BUILD_NUMBER}.ipa"
cp "${source_ipa}" "${target_ipa}"
codesign --verify --deep --strict "${archive}/Products/Applications/App.app"
printf '%s\n' "${target_ipa}"
