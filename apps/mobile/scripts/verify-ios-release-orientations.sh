#!/usr/bin/env bash
set -euo pipefail

info_plist="${1:?built application Info.plist path is required}"

orientation_at() {
  local key="$1"
  local index="$2"
  plutil -extract "${key}.${index}" raw -o - "${info_plist}"
}

assert_orientation() {
  local key="$1"
  local index="$2"
  local expected="$3"
  local actual
  actual="$(orientation_at "${key}" "${index}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "${key}.${index} must be ${expected}, got ${actual}" >&2
    exit 1
  fi
}

assert_no_orientation() {
  local key="$1"
  local index="$2"
  if orientation_at "${key}" "${index}" >/dev/null 2>&1; then
    echo "${key} contains an unexpected orientation at index ${index}" >&2
    exit 1
  fi
}

assert_orientation UISupportedInterfaceOrientations 0 UIInterfaceOrientationPortrait
assert_no_orientation UISupportedInterfaceOrientations 1

assert_orientation 'UISupportedInterfaceOrientations~ipad' 0 UIInterfaceOrientationPortrait
assert_orientation 'UISupportedInterfaceOrientations~ipad' 1 UIInterfaceOrientationPortraitUpsideDown
assert_orientation 'UISupportedInterfaceOrientations~ipad' 2 UIInterfaceOrientationLandscapeLeft
assert_orientation 'UISupportedInterfaceOrientations~ipad' 3 UIInterfaceOrientationLandscapeRight
assert_no_orientation 'UISupportedInterfaceOrientations~ipad' 4
