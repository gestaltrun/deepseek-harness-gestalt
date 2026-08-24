#!/usr/bin/env bash

rollback_platform() (
  set +e
  rollback_failed=0
  for rollback_host in "${hosts[@]}"; do
    rollback_host="${rollback_host// /}"
    ssh -i /tmp/ecs.pem -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes "root@${rollback_host}" \
      "if docker inspect dsh-platform-rollback >/dev/null 2>&1; then \
         docker stop --time 60 dsh-platform >/dev/null 2>&1 || true; \
         docker rm -f dsh-platform >/dev/null 2>&1 || true; \
         docker rename dsh-platform-rollback dsh-platform && docker start dsh-platform; \
       fi; docker rm -f dsh-platform-candidate >/dev/null 2>&1 || true; \
       rm -f /run/dsh-platform-candidate.env" || rollback_failed=1
  done
  exit "$rollback_failed"
)

on_deploy_error() {
  status=$?
  trap - ERR
  rollback_platform || echo 'platform: one or more hosts failed to restore the predecessor' >&2
  exit "$status"
}

platform_public_readiness() {
  attempts="$1"
  public_ready=0
  expected_instances=()
  for expected_host in "${hosts[@]}"; do
    expected_host="${expected_host// /}"
    expected_instances+=("relay-${expected_host//./-}")
  done
  ready_instances='|'
  ready_instance_count=0
  echo 'public readiness through the production HTTPS origin'
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if body=$(curl -fsS --connect-timeout 5 --max-time 5 "${PLATFORM_ORIGIN}/readyz") \
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
