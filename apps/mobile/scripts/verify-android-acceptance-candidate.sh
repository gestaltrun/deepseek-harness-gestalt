#!/usr/bin/env bash
set -euo pipefail

manifest="${1:?acceptance candidate manifest is required}"
apk="${2:?acceptance candidate APK is required}"
: "${CANDIDATE_SHA:?}" "${PLAN_PATH:?}" "${MOBILE_VERSION:?}" "${MOBILE_BUILD_NUMBER:?}"
: "${OPERATED_ORIGIN:?}" "${EXPECTED_REPOSITORY:?}" "${EXPECTED_WORKFLOW_RUN:?}"

apksigner="${APKSIGNER_PATH:-}"
if [ -z "$apksigner" ]; then
  apksigner=$(find "${ANDROID_SDK_ROOT:?}/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print | sort -V | tail -1)
fi
test -x "$apksigner"

apk_name=$(basename "$apk")
apk_digest=$(sha256sum "$apk" | cut -d ' ' -f 1)
signer=$($apksigner verify --print-certs "$apk" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
[[ "$signer" =~ ^[0-9a-fA-F]{64}$ ]]
origin_digest=$(printf '%s' "$OPERATED_ORIGIN" | sha256sum | cut -d ' ' -f 1)
packaging_digest=$(sha256sum apps/mobile/scripts/build-android-release.sh | cut -d ' ' -f 1)

jq -e --arg candidate "$CANDIDATE_SHA" --arg plan "$PLAN_PATH" \
  --arg version "$MOBILE_VERSION" --argjson build "$MOBILE_BUILD_NUMBER" \
  --arg repository "$EXPECTED_REPOSITORY" --arg workflowRun "$EXPECTED_WORKFLOW_RUN" \
  --arg apk "$apk_name" --arg artifact "sha256:$apk_digest" \
  --arg signer "sha256:${signer,,}" --arg origin "sha256:$origin_digest" \
  --arg packaging "sha256:$packaging_digest" \
  '.version == 1 and .mode == "acceptance-candidate" and .surface == "mobile"
    and .candidateCommit == $candidate and .planPath == $plan
    and .productVersion == $version and .buildNumber == $build
    and .repository == $repository and .workflowRun == $workflowRun
    and .artifactDigests == {($apk):$artifact}
    and .signerCertificateSha256 == $signer
    and .operatedOriginSha256 == $origin
    and .packagingScriptSha256 == $packaging
    and (keys | sort == ["artifactDigests","buildNumber","candidateCommit","mode","operatedOriginSha256","packagingScriptSha256","planPath","productVersion","repository","signerCertificateSha256","surface","version","workflowRun"])' \
  "$manifest" >/dev/null
