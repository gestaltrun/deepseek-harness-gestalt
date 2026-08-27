#!/usr/bin/env bash
set -euo pipefail

profile_plist="${1:?profile plist path is required}"
profile_expiration="$(plutil -extract ExpirationDate raw -o - "${profile_plist}")"

date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "${profile_expiration}" '+%s'
