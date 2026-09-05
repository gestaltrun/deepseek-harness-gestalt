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

platform_https_get_address() {
  node --input-type=module - "$1" "$2" <<'NODE'
import https from 'node:https'
import tls from 'node:tls'

const url = new URL(process.argv[2])
const address = process.argv[3]
if (url.protocol !== 'https:') throw new Error('platform: pre-DNS readiness requires HTTPS')
try {
  const body = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: address,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { host: url.host },
      servername: url.hostname,
      checkServerIdentity: tls.checkServerIdentity,
      timeout: 5_000,
    }, response => {
      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode ?? 'unknown'}`))
        return
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('request timed out')))
    request.on('error', reject)
    request.end()
  })
  process.stdout.write(body)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`platform: pre-DNS readiness request failed: ${message}`)
  process.exitCode = 1
}
NODE
}

platform_public_readiness() {
  local attempts="$1" bootstrap_eips="${2:-}" public_ready=0 expected_index expected_instance body attempt
  local ready_instances='|' ready_instance_count=0
  local -a expected_instances=() readiness_eips=()
  for ((expected_index = 1; expected_index <= ${#instance_ids[@]}; expected_index += 1)); do
    expected_instances+=("relay-${expected_index}")
  done
  if [ -n "$bootstrap_eips" ]; then
    IFS=',' read -r -a readiness_eips <<< "$bootstrap_eips"
    if [ "${#readiness_eips[@]}" != 2 ] || [ "${readiness_eips[0]}" = "${readiness_eips[1]}" ]; then
      echo 'platform: bootstrap readiness requires exactly two distinct EIP addresses' >&2
      return 1
    fi
    for expected_index in 0 1; do
      if [[ ! "${readiness_eips[$expected_index]}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        echo 'platform: bootstrap readiness contains an invalid EIP address' >&2
        return 1
      fi
    done
    echo 'pre-DNS readiness through both explicit EIP addresses'
    for expected_index in 0 1; do
      public_ready=0
      expected_instance="relay-$((expected_index + 1))"
      for ((attempt = 1; attempt <= attempts; attempt += 1)); do
        if body=$(platform_https_get_address "${PLATFORM_ORIGIN}/readyz" "${readiness_eips[$expected_index]}") \
          && printf '%s' "$body" | grep -Fq '"ok":true' \
          && printf '%s' "$body" | grep -Fq '"attachmentStorage":"oss"' \
          && printf '%s' "$body" | grep -Fq '"instanceId":"'"$expected_instance"'"'; then
          public_ready=1
          break
        fi
        sleep 2
      done
      test "$public_ready" = 1 || return 1
    done
    return 0
  fi
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
