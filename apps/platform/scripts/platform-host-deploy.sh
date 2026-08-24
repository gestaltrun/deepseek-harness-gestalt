#!/usr/bin/env bash

set -eEuo pipefail

action="${1:?platform host action is required}"
candidate_env=/run/dsh-platform-candidate.env
exec 9>/run/dsh-platform-deploy.lock
flock -x 9

wait_for_storage() {
  local port="$1" expected_storage="$2" body attempt
  for attempt in $(seq 1 30); do
    if body=$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/readyz") \
      && printf '%s' "$body" | grep -Fq '"attachmentStorage":"'"$expected_storage"'"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_ready() {
  local port="$1" body attempt
  for attempt in $(seq 1 30); do
    if body=$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/readyz") \
      && printf '%s' "$body" | grep -Fq '"ok":true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_container_absent() {
  local container_name="$1" container_names
  docker info >/dev/null || return 1
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  container_names=$(docker ps -a --format '{{.Names}}') || return 1
  if grep -Fxq "$container_name" <<< "$container_names"; then
    return 1
  fi
}

case "$action" in
  prepare)
    : "${DSH_DEPLOY_IMAGE_URL:?}" "${DSH_DEPLOY_IMAGE_SHA256:?}" "${DSH_DEPLOY_ENV_URL:?}"
    : "${DSH_DEPLOY_ENV_SHA256:?}" "${DSH_DEPLOY_ENV_KEY:?}" "${DSH_DEPLOY_IMAGE:?}"
    : "${DSH_DEPLOY_STORAGE:?}" "${DSH_RELAY_INSTANCE_ID:?}"
    dnf -y install docker openssl >/dev/null 2>&1 || yum -y install docker openssl >/dev/null 2>&1
    systemctl enable --now docker
    workdir=$(mktemp -d /run/dsh-platform-prepare.XXXXXX)
    cleanup_prepare() {
      find "$workdir" -type f -delete
      rmdir "$workdir"
    }
    trap cleanup_prepare EXIT
    curl --proto '=https' --tlsv1.2 -fsS "$DSH_DEPLOY_IMAGE_URL" -o "$workdir/platform.tar.gz"
    curl --proto '=https' --tlsv1.2 -fsS "$DSH_DEPLOY_ENV_URL" -o "$workdir/platform.env.enc"
    printf '%s  %s\n' "$DSH_DEPLOY_IMAGE_SHA256" "$workdir/platform.tar.gz" | sha256sum -c -
    printf '%s  %s\n' "$DSH_DEPLOY_ENV_SHA256" "$workdir/platform.env.enc" | sha256sum -c -
    gzip -dc "$workdir/platform.tar.gz" | docker load
    install -m 600 /dev/null "$candidate_env"
    DSH_DEPLOY_ENV_KEY="$DSH_DEPLOY_ENV_KEY" openssl enc -d -aes-256-cbc -pbkdf2 \
      -in "$workdir/platform.env.enc" -out "$candidate_env" -pass env:DSH_DEPLOY_ENV_KEY
    printf 'PLATFORM_RELAY_INSTANCE_ID=%s\n' "$DSH_RELAY_INSTANCE_ID" >> "$candidate_env"
    if [ "$DSH_DEPLOY_STORAGE" = oss ]; then
      docker run --rm --network host --env-file "$candidate_env" "$DSH_DEPLOY_IMAGE" \
        node dist/oss-lifecycle-cli.mjs
    fi
    docker rm -f dsh-platform-candidate >/dev/null 2>&1 || true
    docker run -d --name dsh-platform-candidate --restart no \
      --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
      -p 127.0.0.1:18080:8080 --env-file "$candidate_env" "$DSH_DEPLOY_IMAGE"
    wait_for_storage 18080 "$DSH_DEPLOY_STORAGE"

    token=$(curl -fsS --max-time 5 -X PUT http://100.100.100.200/latest/api/token \
      -H 'X-aliyun-ecs-metadata-token-ttl-seconds:60' || true)
    account=
    if [ -n "$token" ]; then
      account=$(curl -fsS --max-time 5 -H "X-aliyun-ecs-metadata-token: $token" \
        http://100.100.100.200/latest/meta-data/owner-account-id || true)
    fi
    account="${account:-${PLATFORM_SLS_ACCOUNT_ID:-}}"
    test -n "$account"
    collector_image=aliyun-observability-release-registry.cn-hangzhou.cr.aliyuncs.com/loongcollector/loongcollector:v3.0.12.0-25723a1-aliyun
    if ! docker pull "$collector_image"; then
      docker image inspect "$collector_image" >/dev/null
    fi
    docker rm -f dsh-loongcollector >/dev/null 2>&1 || true
    docker run -d --name dsh-loongcollector --restart unless-stopped \
      -v /:/logtail_host:ro \
      -v /var/run/docker.sock:/var/run/docker.sock \
      --env ALIYUN_LOGTAIL_CONFIG=/etc/ilogtail/conf/cn-hangzhou/ilogtail_config.json \
      --env ALIYUN_LOGTAIL_USER_ID="$account" \
      --env ALIYUN_LOGTAIL_USER_DEFINED_ID=gestalt-platform \
      "$collector_image"
    ;;
  verify-predecessor)
    : "${DSH_DEPLOY_STORAGE:?}"
    docker inspect dsh-platform >/dev/null
    ! docker inspect dsh-platform-rollback >/dev/null 2>&1
    body=$(curl -fsS --max-time 5 http://127.0.0.1:80/readyz)
    if [ "$DSH_DEPLOY_STORAGE" = oss ]; then
      printf '%s' "$body" | grep -Eq '"attachmentStorage":"(postgres|oss)"'
    fi
    ;;
  replace)
    : "${DSH_DEPLOY_IMAGE:?}" "${DSH_DEPLOY_STORAGE:?}"
    docker rename dsh-platform dsh-platform-rollback
    docker stop --time 60 dsh-platform-rollback
    docker rm -f dsh-platform-candidate >/dev/null
    docker run -d --name dsh-platform --restart unless-stopped \
      --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
      -p 80:8080 --env-file "$candidate_env" "$DSH_DEPLOY_IMAGE"
    wait_for_storage 80 "$DSH_DEPLOY_STORAGE"
    ;;
  rollback)
    set +e
    rollback_failed=0
    docker info >/dev/null || exit 1
    rollback_containers=$(docker ps -a --format '{{.Names}}') || exit 1
    if grep -Fxq dsh-platform-rollback <<< "$rollback_containers"; then
      docker stop --time 60 dsh-platform >/dev/null 2>&1 || true
      docker rm -f dsh-platform >/dev/null 2>&1 || true
      docker rename dsh-platform-rollback dsh-platform && docker start dsh-platform \
        || rollback_failed=1
    fi
    ensure_container_absent dsh-platform-candidate || rollback_failed=1
    unlink "$candidate_env" 2>/dev/null || true
    test ! -e "$candidate_env" || rollback_failed=1
    wait_for_ready 80 || rollback_failed=1
    exit "$rollback_failed"
    ;;
  cleanup-rollback)
    docker rm dsh-platform-rollback >/dev/null
    ;;
  complete-rollback-cleanup)
    ensure_container_absent dsh-platform-rollback
    ;;
  cutover)
    deploy_image="${DSH_DEPLOY_IMAGE:-$(docker inspect dsh-platform --format '{{.Config.Image}}')}"
    docker run --rm --network host --env-file "$candidate_env" "$deploy_image" \
      node dist/attachment-storage-cutover-cli.mjs
    ;;
  finalize)
    unlink "$candidate_env"
    ;;
  complete-commit)
    ensure_container_absent dsh-platform-rollback
    ensure_container_absent dsh-platform-candidate
    unlink "$candidate_env" 2>/dev/null || true
    test ! -e "$candidate_env"
    ;;
  *)
    printf 'platform: unsupported host action: %s\n' "$action" >&2
    exit 2
    ;;
esac
