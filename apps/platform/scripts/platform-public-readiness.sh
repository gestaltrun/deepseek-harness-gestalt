#!/usr/bin/env bash

platform_https_get() {
  node --input-type=module - "$1" <<'NODE'
const url = process.argv[2]
try {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  process.stdout.write(await response.text())
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`platform: public readiness request failed: ${message}`)
  process.exitCode = 1
}
NODE
}

platform_public_readiness() {
  local attempts="$1" public_ready=0 expected_index expected_instance body
  local ready_instances='|' ready_instance_count=0
  local -a expected_instances=()
  for ((expected_index = 1; expected_index <= ${#instance_ids[@]}; expected_index += 1)); do
    expected_instances+=("relay-${expected_index}")
  done
  echo 'public readiness through the production HTTPS origin'
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if body=$(platform_https_get "${PLATFORM_ORIGIN}/readyz") \
      && printf '%s' "$body" | grep -Fq '"attachmentStorage":"'"$PLATFORM_REMOTE_ATTACHMENT_STORAGE"'"'; then
      for expected_instance in "${expected_instances[@]}"; do
        if printf '%s' "$body" | grep -Fq '"instanceId":"'"$expected_instance"'"'; then
          case "$ready_instances" in
            *"|${expected_instance}|"*) ;;
            *)
              ready_instances="${ready_instances}${expected_instance}|"
              ready_instance_count=$((ready_instance_count + 1))
              ;;
          esac
        fi
      done
      if [ "$ready_instance_count" -eq "${#expected_instances[@]}" ]; then
        public_ready=1
        break
      fi
    fi
    sleep 2
  done
  test "$public_ready" = 1
}
