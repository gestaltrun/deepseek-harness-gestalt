#!/usr/bin/env bash

set -eEuo pipefail
umask 077
set +x

fail() { printf 'platform certificate: %s\n' "$1" >&2; exit 1; }
require_name() { [[ "$1" =~ ^[A-Za-z0-9.-]+$ ]] || fail "invalid $2"; }
require_positive() { [[ "$1" =~ ^[1-9][0-9]*$ ]] || fail "invalid $2"; }
require_ip() {
  local ip="$1" part
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'invalid ALB EIP'
  IFS=. read -r -a parts <<< "$ip"
  for part in "${parts[@]}"; do (( part <= 255 )) || fail 'invalid ALB EIP'; done
}

: "${PLATFORM_CERT_DOMAIN:?}" "${PLATFORM_CERT_WWW_DOMAIN:?}" "${PLATFORM_CERT_ALB_EIPS:?}"
: "${PLATFORM_CERT_ALB_LISTENER_ID:?}" "${PLATFORM_CERT_OSS_BUCKET:?}"
: "${PLATFORM_CERT_OSS_ENDPOINT:?}" "${PLATFORM_CERT_STATE_OBJECT:?}"
: "${PLATFORM_ALIYUN_REGION:?}" "${ACME_ARCHIVE_URL:?}" "${ACME_ARCHIVE_SHA256:?}"
mode="${1:-renew}"
[[ "$mode" = renew || "$mode" = validate ]] || { echo 'platform certificate: expected renew or validate' >&2; exit 2; }
renew_before_days="${PLATFORM_CERT_RENEW_BEFORE_DAYS:-30}"
minimum_days="${PLATFORM_CERT_MINIMUM_VALID_DAYS:-60}"
require_name "$PLATFORM_CERT_DOMAIN" PLATFORM_CERT_DOMAIN
require_name "$PLATFORM_CERT_WWW_DOMAIN" PLATFORM_CERT_WWW_DOMAIN
[[ "$PLATFORM_CERT_WWW_DOMAIN" = "www.$PLATFORM_CERT_DOMAIN" ]] || fail 'www domain must belong to apex domain'
require_name "$PLATFORM_CERT_OSS_BUCKET" PLATFORM_CERT_OSS_BUCKET
require_name "$PLATFORM_CERT_OSS_ENDPOINT" PLATFORM_CERT_OSS_ENDPOINT
[[ "$PLATFORM_CERT_ALB_LISTENER_ID" =~ ^lsn-[A-Za-z0-9]+$ ]] || fail 'invalid listener id'
[[ "$PLATFORM_CERT_STATE_OBJECT" =~ ^certificate-renewal/[A-Za-z0-9._/-]+$ && "$PLATFORM_CERT_STATE_OBJECT" != */../* ]] || fail 'invalid state object'
require_positive "$renew_before_days" PLATFORM_CERT_RENEW_BEFORE_DAYS
require_positive "$minimum_days" PLATFORM_CERT_MINIMUM_VALID_DAYS
IFS=',' read -r -a alb_eips <<< "$PLATFORM_CERT_ALB_EIPS"
[[ "${#alb_eips[@]}" = 2 ]] || fail 'exactly two ALB EIPs are required'
for index in "${!alb_eips[@]}"; do alb_eips[$index]="${alb_eips[$index]// /}"; require_ip "${alb_eips[$index]}"; done

workdir=$(mktemp -d)
chmod 700 "$workdir"
acme_home="$workdir/acme-home"
archive="$workdir/acme.tar.gz"
state_archive="$workdir/state.tar.gz"
record_ids="$workdir/challenge-record-ids"
mkdir -m 700 "$acme_home" "$workdir/acme-source" "$workdir/current"
: > "$record_ids"
listener_changed=0
prior_listener_cert=
# Evidence fallback for an OSS outage: owner-only file on the runner, uploaded by the
# workflow as a private run artifact. Contains no secrets: record ids, the prior
# certificate id, and the failed upload's stderr.
local_evidence="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/platform-certificate-renewal-cleanup-evidence.json"
cleanup_files() {
  find "$workdir" -type f -delete 2>/dev/null || true
  rm -rf "$workdir"
}
cleanup_dns() {
  local pending="$workdir/challenge-record-ids.pending" failed=0 record_id
  : > "$pending"
  while IFS= read -r record_id; do
    [ -n "$record_id" ] || continue
    if aliyun alidns DeleteDomainRecord --RegionId "$PLATFORM_ALIYUN_REGION" --RecordId "$record_id" >/dev/null 2>"$workdir/dns-delete.err"; then
      continue
    fi
    # An already-absent record satisfies cleanup; retries must converge after a kill
    # that followed a successful delete.
    if grep -Fq 'NotFound' "$workdir/dns-delete.err"; then continue; fi
    printf '%s\n' "$record_id" >> "$pending"
    failed=1
  done < "$record_ids"
  mv "$pending" "$record_ids"
  return "$failed"
}
restore_listener() {
  [ "$listener_changed" = 1 ] || return 0
  aliyun alb UpdateListenerAttribute --RegionId "$PLATFORM_ALIYUN_REGION" \
    --ListenerId "$PLATFORM_CERT_ALB_LISTENER_ID" \
    --Certificates.1.CertificateId "$prior_listener_cert" --force >/dev/null
  listener_changed=0
}
on_exit() {
  local status="$1"
  # validate never mutates DNS, including restored ledger ids; it only reports them.
  if [ "$mode" = renew ] && ! cleanup_dns; then
    if [ -n "${metadata_uri:-}" ]; then persist_cleanup_evidence || true; fi
    status=1
  fi
  if [ "$status" != 0 ] && ! restore_listener; then echo 'platform certificate: failed to restore prior listener certificate' >&2; status=1; fi
  cleanup_files
  exit "$status"
}
trap 'on_exit $?' EXIT
trap 'trap - EXIT; on_exit 130' INT
trap 'trap - EXIT; on_exit 143' TERM

curl --proto '=https' --tlsv1.2 -fsS "$ACME_ARCHIVE_URL" -o "$archive"
printf '%s  %s\n' "$ACME_ARCHIVE_SHA256" "$archive" | sha256sum -c - >/dev/null
tar -xzf "$archive" --strip-components=1 -C "$workdir/acme-source"
chmod 700 "$workdir/acme-source/acme.sh"
state_uri="oss://${PLATFORM_CERT_OSS_BUCKET}/${PLATFORM_CERT_STATE_OBJECT}"
metadata_uri="${state_uri}.transaction.json"
transaction_file="$workdir/transaction.json"
read_oss_object() {
  local uri="$1" destination="$2" error_file="$3"
  set +e
  aliyun oss cp "$uri" "$destination" --region "$PLATFORM_ALIYUN_REGION" \
    --endpoint "$PLATFORM_CERT_OSS_ENDPOINT" --force >/dev/null 2>"$error_file"
  local status=$?
  set -e
  if [ "$status" != 0 ] && ! grep -Fq 'StatusCode=404' "$error_file"; then return "$status"; fi
  return "$status"
}
write_transaction() {
  local phase="$1" prior="$2" current="$3" fingerprint="$4" cleanup_ids="${5:-[]}"
  jq -nc --arg phase "$phase" --arg prior "$prior" --arg current "$current" --arg fingerprint "$fingerprint" \
    --argjson cleanupRecordIds "$cleanup_ids" \
    '{version:1,phase:$phase,priorCertificateId:$prior,currentCertificateId:$current,fingerprint:$fingerprint,cleanupRecordIds:$cleanupRecordIds}' \
    > "$transaction_file"
  aliyun oss cp "$transaction_file" "$metadata_uri" --region "$PLATFORM_ALIYUN_REGION" \
    --endpoint "$PLATFORM_CERT_OSS_ENDPOINT" --meta 'x-oss-server-side-encryption:AES256' --force \
    >/dev/null 2>"$workdir/oss-write.err"
}
persist_cleanup_evidence() {
  local ids upload_error
  ids=$(jq -Rsc 'split("\n") | map(select(length > 0))' < "$record_ids")
  if write_transaction cleanup-pending "${prior_listener_cert:-}" "" "" "$ids"; then
    echo 'platform certificate: challenge cleanup incomplete; remaining record ids retained in durable transaction evidence' >&2
    return 0
  fi
  # The remote transaction object is unreachable, so durability cannot be claimed:
  # retain the remaining ids and the upload failure output in protected local evidence.
  upload_error=$(tr '\n' ' ' < "$workdir/oss-write.err" | cut -c1-500)
  jq -nc --arg prior "${prior_listener_cert:-}" --argjson cleanupRecordIds "$ids" --arg uploadError "$upload_error" \
    '{version:1,phase:"cleanup-pending",priorCertificateId:$prior,cleanupRecordIds:$cleanupRecordIds,evidenceUploadError:$uploadError}' \
    > "$local_evidence"
  echo "platform certificate: challenge cleanup incomplete; transaction evidence upload failed, so remaining record ids and the upload error are retained only in protected local evidence $local_evidence" >&2
  return 1
}
# A renewal run deletes every challenge record the exact allowed names still serve,
# closing the kill window between AddDomainRecord and its transaction persistence.
sweep_residual_challenges() {
  local fqdn rr response record_id swept=0
  for fqdn in "_acme-challenge.${PLATFORM_CERT_DOMAIN}" "_acme-challenge.${PLATFORM_CERT_WWW_DOMAIN}"; do
    rr="${fqdn%.${PLATFORM_CERT_DOMAIN}}"
    response=$(aliyun alidns DescribeDomainRecords --RegionId "$PLATFORM_ALIYUN_REGION" \
      --DomainName "$PLATFORM_CERT_DOMAIN" --RRKeyWord "$rr" --Type TXT) \
      || fail 'failed to query residual challenge records'
    while IFS= read -r record_id; do
      [ -n "$record_id" ] || continue
      printf '%s\n' "$record_id" >> "$record_ids"
      swept=1
    done < <(printf '%s' "$response" | jq -r --arg rr "$rr" \
      '.DomainRecords.Record[]? | select(.RR == $rr and .Type == "TXT") | .RecordId')
  done
  if [ "$swept" = 1 ] && ! cleanup_dns; then
    persist_cleanup_evidence || true
    fail 'challenge cleanup is still incomplete; residual challenge records remain'
  fi
}
if read_oss_object "$state_uri" "$state_archive" "$workdir/state-read.err"; then
  tar -xzf "$state_archive" -C "$acme_home"
elif ! grep -Fq 'StatusCode=404' "$workdir/state-read.err"; then
  fail 'failed to read ACME state'
fi
transaction_phase=
transaction_prior=
transaction_current=
transaction_fingerprint=
if read_oss_object "$metadata_uri" "$transaction_file" "$workdir/transaction-read.err"; then
  transaction_phase=$(jq -er 'select(.version == 1) | .phase' "$transaction_file")
  transaction_prior=$(jq -r '.priorCertificateId // ""' "$transaction_file")
  transaction_current=$(jq -r '.currentCertificateId // ""' "$transaction_file")
  transaction_fingerprint=$(jq -r '.fingerprint // ""' "$transaction_file")
  # Every recorded leftover challenge id re-enters the retry ledger, from any phase.
  jq -r '.cleanupRecordIds // [] | .[]' "$transaction_file" >> "$record_ids"
elif ! grep -Fq 'StatusCode=404' "$workdir/transaction-read.err"; then
  fail 'failed to read renewal transaction'
fi

listener=$(aliyun alb GetListenerAttribute --RegionId "$PLATFORM_ALIYUN_REGION" --ListenerId "$PLATFORM_CERT_ALB_LISTENER_ID")
prior_listener_cert=$(printf '%s' "$listener" | jq -er '.Certificates | select(length == 1) | .[0].CertificateId')
if [ "$transaction_phase" = issued ]; then
  issued_prior="$transaction_prior"
  issued_current="$transaction_current"
  issued_fingerprint="$transaction_fingerprint"
  if [ -z "$issued_prior" ] || [ -z "$issued_current" ] || [ -z "$issued_fingerprint" ]; then
    fail 'issued transaction is incomplete'
  fi
  if [ "$mode" = validate ]; then
    echo "platform certificate: pending issued transaction requires renewal reconciliation"
    exit 0
  fi
  prior_listener_cert="$issued_prior"
  if ! cleanup_dns; then
    persist_cleanup_evidence || true
    fail 'challenge cleanup is still incomplete; issued reconciliation aborted'
  fi
  # Own rollback for the recorded candidate even when the listener already serves it:
  # a later verification or commit failure must restore the recorded prior certificate.
  listener_changed=1
  if [ "$(printf '%s' "$listener" | jq -er '.Certificates[0].CertificateId')" != "$issued_current" ]; then
    aliyun alb UpdateListenerAttribute --RegionId "$PLATFORM_ALIYUN_REGION" --ListenerId "$PLATFORM_CERT_ALB_LISTENER_ID" \
      --Certificates.1.CertificateId "$issued_current" --force >/dev/null
  fi
  for host in "$PLATFORM_CERT_DOMAIN" "$PLATFORM_CERT_WWW_DOMAIN"; do
    for ip in "${alb_eips[@]}"; do
      curl --proto '=https' --tlsv1.2 -sS --resolve "$host:443:$ip" "https://$host/healthz" -o /dev/null
      served=$(echo | openssl s_client -connect "$ip:443" -servername "$host" 2>/dev/null \
        | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2-)
      [ "$served" = "$issued_fingerprint" ] || fail 'issued certificate reconciliation did not reach every name and EIP'
    done
  done
  write_transaction committed "$issued_prior" "$issued_current" "$issued_fingerprint" '[]'
  listener_changed=0
  echo "platform certificate: reconciled issued certificate $issued_current; previous certificate retained"
  exit 0
fi
if [ "$transaction_phase" = cleanup-pending ] || [ -s "$record_ids" ]; then
  if [ "$mode" = validate ]; then
    echo "platform certificate: pending challenge cleanup requires renewal reconciliation"
    exit 0
  fi
  if ! cleanup_dns; then
    persist_cleanup_evidence || true
    fail 'challenge cleanup is still incomplete; renewal deferred'
  fi
  # The transaction object is never deleted; the terminal committed phase closes it.
  write_transaction committed "$transaction_prior" "$transaction_current" "$transaction_fingerprint" '[]'
fi
if [ "$mode" = renew ]; then
  sweep_residual_challenges
fi

current_fingerprint=
current_end=0
for host in "$PLATFORM_CERT_DOMAIN" "$PLATFORM_CERT_WWW_DOMAIN"; do
  for ip in "${alb_eips[@]}"; do
    curl --proto '=https' --tlsv1.2 -sS --resolve "$host:443:$ip" "https://$host/healthz" -o /dev/null
    leaf="$workdir/current/${host}-${ip}.pem"
    echo | openssl s_client -connect "$ip:443" -servername "$host" 2>/dev/null | openssl x509 -outform PEM > "$leaf"
    fingerprint=$(openssl x509 -in "$leaf" -noout -fingerprint -sha256 | cut -d= -f2-)
    end=$(openssl x509 -in "$leaf" -noout -enddate | cut -d= -f2-)
    epoch=$(date -u -d "$end" +%s)
    if [ -z "$current_fingerprint" ]; then current_fingerprint="$fingerprint"; current_end="$epoch"
    elif [ "$current_fingerprint" != "$fingerprint" ] || [ "$current_end" != "$epoch" ]; then fail 'ALB names or EIPs present different certificates'; fi
  done
done
now=$(date -u +%s)
due_at=$((current_end - renew_before_days * 86400))
if [ "$mode" = validate ] || [ "$now" -lt "$due_at" ]; then
  echo 'platform certificate: current certificate is not due; validation passed'
  exit 0
fi

# Standalone persist helper invoked by the DNS hook after every added record, so a
# hard kill cannot leave an untracked challenge record wider than one add. Runs under
# any shell acme.sh uses because it receives configuration through the environment.
cat > "$workdir/persist-record-ids.sh" <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
umask 077
ids=$(jq -Rsc 'split("\n") | map(select(length > 0))' < "$GESTALT_ACME_RECORD_IDS")
jq -nc --arg prior "$GESTALT_ACME_PRIOR_CERT" --argjson cleanupRecordIds "$ids" \
  '{version:1,phase:"cleanup-pending",priorCertificateId:$prior,currentCertificateId:"",fingerprint:"",cleanupRecordIds:$cleanupRecordIds}' \
  > "$GESTALT_ACME_TRANSACTION_FILE"
aliyun oss cp "$GESTALT_ACME_TRANSACTION_FILE" "$GESTALT_ACME_METADATA_URI" \
  --region "$PLATFORM_ALIYUN_REGION" --endpoint "$PLATFORM_CERT_OSS_ENDPOINT" \
  --meta 'x-oss-server-side-encryption:AES256' --force >/dev/null
HELPER
chmod 700 "$workdir/persist-record-ids.sh"
cat > "$workdir/acme-source/dnsapi/dns_gestalt_oidc.sh" <<'HOOK'
#!/usr/bin/env sh
dns_gestalt_oidc_add() {
  case "$1" in
    "_acme-challenge.${PLATFORM_CERT_DOMAIN}"|"_acme-challenge.${PLATFORM_CERT_WWW_DOMAIN}") ;;
    *) _err 'refusing unexpected DNS challenge name'; return 1 ;;
  esac
  _rr="${1%.${PLATFORM_CERT_DOMAIN}}"
  response=$(aliyun alidns AddDomainRecord --RegionId "$PLATFORM_ALIYUN_REGION" \
    --DomainName "$PLATFORM_CERT_DOMAIN" --RR "$_rr" --Type TXT --Value "$2") || return 1
  printf '%s\n' "$(printf '%s' "$response" | jq -er '.RecordId')" >> "$GESTALT_ACME_RECORD_IDS"
  "$GESTALT_ACME_PERSIST_HOOK" || return 1
}
dns_gestalt_oidc_rm() { cleanup_dns; }
HOOK
chmod 600 "$workdir/acme-source/dnsapi/dns_gestalt_oidc.sh"
export GESTALT_ACME_RECORD_IDS="$record_ids"
export GESTALT_ACME_PERSIST_HOOK="$workdir/persist-record-ids.sh"
export GESTALT_ACME_TRANSACTION_FILE="$transaction_file"
export GESTALT_ACME_METADATA_URI="$metadata_uri"
export GESTALT_ACME_PRIOR_CERT="$prior_listener_cert"
export -f cleanup_dns
acme="$workdir/acme-source/acme.sh"
if [ -f "$acme_home/$PLATFORM_CERT_WWW_DOMAIN"'_ecc/'"$PLATFORM_CERT_WWW_DOMAIN.conf" ]; then
  "$acme" --home "$acme_home" --renew -d "$PLATFORM_CERT_WWW_DOMAIN" --ecc --force
else
  "$acme" --home "$acme_home" --issue --server letsencrypt --keylength ec-256 \
    --dns dns_gestalt_oidc -d "$PLATFORM_CERT_WWW_DOMAIN" -d "$PLATFORM_CERT_DOMAIN"
fi
if ! cleanup_dns; then
  persist_cleanup_evidence || true
  fail 'challenge cleanup incomplete; renewal aborted before activation'
fi

cert_dir="$acme_home/${PLATFORM_CERT_WWW_DOMAIN}_ecc"
cert="$cert_dir/fullchain.cer"
key="$cert_dir/$PLATFORM_CERT_WWW_DOMAIN.key"
openssl pkey -in "$key" -pubout -out "$workdir/key.pub" 2>/dev/null
openssl x509 -in "$cert" -pubkey -noout > "$workdir/cert.pub"
cmp -s "$workdir/key.pub" "$workdir/cert.pub" || fail 'certificate and key differ'
san=$(openssl x509 -in "$cert" -noout -text | sed -n '/Subject Alternative Name/{n;s/^[[:space:]]*//;p;}')
expected_a="DNS:$PLATFORM_CERT_DOMAIN, DNS:$PLATFORM_CERT_WWW_DOMAIN"
expected_b="DNS:$PLATFORM_CERT_WWW_DOMAIN, DNS:$PLATFORM_CERT_DOMAIN"
[[ "$san" = "$expected_a" || "$san" = "$expected_b" ]] || fail 'unexpected SAN set'
openssl x509 -in "$cert" -checkend $((minimum_days * 86400)) -noout >/dev/null || fail 'renewed certificate lifetime is too short'
new_fingerprint=$(openssl x509 -in "$cert" -noout -fingerprint -sha256 | cut -d= -f2-)
cert_name="gestalt-platform-$(date -u +%Y%m%d%H%M%S)"
# The pinned CLI expands only the exact-case -FILE suffix into file contents
# (aliyun-cli 3.4.11 openapi/rpc.go); certificate and key material travel inside the
# signed request, never as an argv literal or a file:// URL.
response=$(aliyun cas UploadUserCertificate --Name "$cert_name" --Cert-FILE "$cert" --Key-FILE "$key")
cert_id=$(printf '%s' "$response" | jq -er '.CertId')
listener_cert_id="${cert_id}-${PLATFORM_ALIYUN_REGION}"

tar -czf "$state_archive" -C "$acme_home" .
aliyun oss cp "$state_archive" "$state_uri" --region "$PLATFORM_ALIYUN_REGION" \
  --endpoint "$PLATFORM_CERT_OSS_ENDPOINT" --meta 'x-oss-server-side-encryption:AES256' --force >/dev/null
write_transaction issued "$prior_listener_cert" "$listener_cert_id" "$new_fingerprint"

aliyun alb UpdateListenerAttribute --RegionId "$PLATFORM_ALIYUN_REGION" --ListenerId "$PLATFORM_CERT_ALB_LISTENER_ID" \
  --Certificates.1.CertificateId "$listener_cert_id" --force >/dev/null
listener_changed=1
for host in "$PLATFORM_CERT_DOMAIN" "$PLATFORM_CERT_WWW_DOMAIN"; do
  for ip in "${alb_eips[@]}"; do
    curl --proto '=https' --tlsv1.2 -sS --resolve "$host:443:$ip" "https://$host/healthz" -o /dev/null
    served=$(echo | openssl s_client -connect "$ip:443" -servername "$host" 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2-)
    [ "$served" = "$new_fingerprint" ] || fail 'ALB did not serve renewed certificate on every name and EIP'
  done
done
write_transaction committed "$prior_listener_cert" "$listener_cert_id" "$new_fingerprint"
listener_changed=0
echo "platform certificate: renewed and activated certificate $listener_cert_id; previous certificate retained"
