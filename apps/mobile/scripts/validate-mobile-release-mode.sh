#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_BUILD_ONLY:?}" "${UPLOAD_TESTFLIGHT:?}" "${PUBLISH_GITHUB:?}"
: "${RECOVER_ARTIFACTS:?}" "${ACCEPT_TRANSPORT_RISK:?}"

for name in CANDIDATE_BUILD_ONLY UPLOAD_TESTFLIGHT PUBLISH_GITHUB RECOVER_ARTIFACTS ACCEPT_TRANSPORT_RISK; do
  value="${!name}"
  if [ "$value" != true ] && [ "$value" != false ]; then
    echo "Mobile release $name must be true or false" >&2
    exit 1
  fi
done

if [ "$CANDIDATE_BUILD_ONLY" = true ]; then
  if [ "$UPLOAD_TESTFLIGHT" = true ] || [ "$PUBLISH_GITHUB" = true ] \
    || [ "$RECOVER_ARTIFACTS" = true ] || [ -n "${ARTIFACT_RUN_ID:-}" ] \
    || [ -n "${ACCEPTANCE_RUN_ID:-}" ]; then
    echo 'Mobile candidate-build-only forbids acceptance, recovery, TestFlight, and GitHub publication inputs' >&2
    exit 1
  fi
  if [ "$ACCEPT_TRANSPORT_RISK" != true ]; then
    echo 'Mobile candidate-build-only requires candidate-scoped transport-risk acceptance' >&2
    exit 1
  fi
elif [ -z "${ACCEPTANCE_RUN_ID:-}" ]; then
  echo 'Mobile release requires a candidate-bound acceptance run' >&2
  exit 1
fi
