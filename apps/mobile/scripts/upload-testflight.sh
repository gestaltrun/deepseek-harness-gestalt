#!/usr/bin/env bash
set -euo pipefail

: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
: "${IPA_PATH:?IPA_PATH is required}"
test -f "${IPA_PATH}"
xcrun altool --upload-app --type ios --file "${IPA_PATH}" \
  --username "${APPLE_ID}" --password "${APPLE_APP_SPECIFIC_PASSWORD}"
