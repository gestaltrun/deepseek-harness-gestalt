#!/usr/bin/env bash

set -eEuo pipefail
umask 077
set +x

: "${PLATFORM_CERT_DOMAIN:?}" "${PLATFORM_CERT_WWW_DOMAIN:?}" "${PLATFORM_CERT_ALB_EIPS:?}"
: "${PLATFORM_CERT_ALB_LISTENER_ID:?}" "${PLATFORM_CERT_OSS_BUCKET:?}"
: "${PLATFORM_CERT_OSS_ENDPOINT:?}" "${PLATFORM_CERT_STATE_OBJECT:?}"
: "${PLATFORM_ALIYUN_REGION:?}"
: "${ACME_ARCHIVE_URL:?}" "${ACME_ARCHIVE_SHA256:?}"

mode="${1:-renew}"
case "$mode" in
  renew|validate) ;;
  *) echo 'platform certificate: expected renew or validate' >&2; exit 2 ;;
esac

workdir=$(mktemp -d)
cleanup() {
  find "$workdir" -type f -delete 2>/dev/null || true
  find "$workdir" -depth -type d -exec rmdir {} \; 2>/dev/null || true
}
trap cleanup EXIT INT TERM
chmod 700 "$workdir"
acme_home="$workdir/acme-home"
archive="$workdir/acme.tar.gz"
state_archive="$workdir/state.tar.gz"
mkdir -m 700 "$acme_home" "$workdir/acme-source"

curl --proto '=https' --tlsv1.2 -fsS "$ACME_ARCHIVE_URL" -o "$archive"
printf '%s  %s\n' "$ACME_ARCHIVE_SHA256" "$archive" | sha256sum -c - >/dev/null
tar -xzf "$archive" --strip-components=1 -C "$workdir/acme-source"
chmod 700 "$workdir/acme-source/acme.sh"

state_uri="oss://${PLATFORM_CERT_OSS_BUCKET}/${PLATFORM_CERT_STATE_OBJECT}"
set +e
aliyun oss cp "$state_uri" "$state_archive" --region "$PLATFORM_ALIYUN_REGION" \
  --endpoint "$PLATFORM_CERT_OSS_ENDPOINT" --force >/dev/null 2>"$workdir/state-read.err"
state_status=$?
set -e
if [ "$state_status" = 0 ]; then
  tar -xzf "$state_archive" -C "$acme_home"
elif ! grep -Fq 'StatusCode=404' "$workdir/state-read.err"; then
  echo 'platform certificate: failed to read encrypted ACME state' >&2
  exit 1
fi

current_dir="$workdir/current"
mkdir -m 700 "$current_dir"
IFS=',' read -r -a alb_eips <<< "$PLATFORM_CERT_ALB_EIPS"
[ "${#alb_eips[@]}" = 2 ] || { echo 'platform certificate: exactly two ALB EIPs are required' >&2; exit 1; }
current_end=0
for index in "${!alb_eips[@]}"; do
  ip="${alb_eips[$index]// /}"
  curl --proto '=https' --tlsv1.2 -sS --resolve "$PLATFORM_CERT_DOMAIN:443:$ip" \
    "https://$PLATFORM_CERT_DOMAIN/healthz" -o /dev/null
  echo | openssl s_client -connect "$ip:443" -servername "$PLATFORM_CERT_DOMAIN" 2>/dev/null \
    | openssl x509 -outform PEM > "$current_dir/$index.pem"
  end=$(openssl x509 -in "$current_dir/$index.pem" -noout -enddate | cut -d= -f2-)
  epoch=$(date -u -d "$end" +%s)
  if [ "$current_end" = 0 ]; then current_end="$epoch"; elif [ "$current_end" != "$epoch" ]; then
    echo 'platform certificate: ALB EIPs present different certificate expiries' >&2
    exit 1
  fi
done

now=$(date -u +%s)
renew_before_days="${PLATFORM_CERT_RENEW_BEFORE_DAYS:-30}"
minimum_days="${PLATFORM_CERT_MINIMUM_VALID_DAYS:-60}"
due_at=$((current_end - renew_before_days * 86400))
if [ "$mode" = validate ] || [ "$now" -lt "$due_at" ]; then
  echo "platform certificate: current certificate is not due; validation passed"
  exit 0
fi

cat > "$workdir/acme-source/dnsapi/dns_gestalt_oidc.sh" <<'HOOK'
#!/usr/bin/env sh

dns_gestalt_oidc_add() {
  _fulldomain="$1"
  _txtvalue="$2"
  _rr="${_fulldomain%.${PLATFORM_CERT_DOMAIN}}"
  response=$(aliyun alidns AddDomainRecord --RegionId "$PLATFORM_ALIYUN_REGION" \
    --DomainName "$PLATFORM_CERT_DOMAIN" --RR "$_rr" --Type TXT --Value "$_txtvalue") || return 1
  record_id=$(printf '%s' "$response" | jq -er '.RecordId') || return 1
  printf '%s\n' "$record_id" >> "$GESTALT_ACME_RECORD_IDS"
}

dns_gestalt_oidc_rm() {
  [ -f "$GESTALT_ACME_RECORD_IDS" ] || return 0
  while IFS= read -r record_id; do
    aliyun alidns DeleteDomainRecord --RegionId "$PLATFORM_ALIYUN_REGION" \
      --RecordId "$record_id" >/dev/null 2>&1 || true
  done < "$GESTALT_ACME_RECORD_IDS"
  : > "$GESTALT_ACME_RECORD_IDS"
}
HOOK
chmod 600 "$workdir/acme-source/dnsapi/dns_gestalt_oidc.sh"
export GESTALT_ACME_RECORD_IDS="$workdir/challenge-record-ids"
: > "$GESTALT_ACME_RECORD_IDS"
cleanup_dns() {
  if [ -s "$GESTALT_ACME_RECORD_IDS" ]; then
    while IFS= read -r record_id; do
      aliyun alidns DeleteDomainRecord --RegionId "$PLATFORM_ALIYUN_REGION" \
        --RecordId "$record_id" >/dev/null 2>&1 || true
    done < "$GESTALT_ACME_RECORD_IDS"
  fi
}
trap 'cleanup_dns; cleanup' EXIT INT TERM

acme="$workdir/acme-source/acme.sh"
if [ -f "$acme_home/$PLATFORM_CERT_WWW_DOMAIN"'_ecc/'"$PLATFORM_CERT_WWW_DOMAIN.conf" ]; then
  "$acme" --home "$acme_home" --renew -d "$PLATFORM_CERT_WWW_DOMAIN" --ecc --force
else
  "$acme" --home "$acme_home" --issue --server letsencrypt --keylength ec-256 \
    --dns dns_gestalt_oidc -d "$PLATFORM_CERT_WWW_DOMAIN" -d "$PLATFORM_CERT_DOMAIN"
fi
cleanup_dns

cert_dir="$acme_home/${PLATFORM_CERT_WWW_DOMAIN}_ecc"
cert="$cert_dir/fullchain.cer"
key="$cert_dir/$PLATFORM_CERT_WWW_DOMAIN.key"
openssl x509 -in "$cert" -noout >/dev/null
openssl pkey -in "$key" -pubout -out "$workdir/key.pub" 2>/dev/null
openssl x509 -in "$cert" -pubkey -noout > "$workdir/cert.pub"
cmp -s "$workdir/key.pub" "$workdir/cert.pub" || { echo 'platform certificate: certificate and key differ' >&2; exit 1; }
san=$(openssl x509 -in "$cert" -noout -text | sed -n '/Subject Alternative Name/{n;s/^[[:space:]]*//;p;}')
expected_a="DNS:$PLATFORM_CERT_DOMAIN, DNS:$PLATFORM_CERT_WWW_DOMAIN"
expected_b="DNS:$PLATFORM_CERT_WWW_DOMAIN, DNS:$PLATFORM_CERT_DOMAIN"
[ "$san" = "$expected_a" ] || [ "$san" = "$expected_b" ] || { echo 'platform certificate: unexpected SAN set' >&2; exit 1; }
openssl x509 -in "$cert" -checkend $((minimum_days * 86400)) -noout >/dev/null

cert_name="gestalt-platform-$(date -u +%Y%m%d%H%M%S)"
response=$(aliyun cas UploadUserCertificate --Name "$cert_name" \
  --Cert "file://$cert" --Key "file://$key")
cert_id=$(printf '%s' "$response" | jq -er '.CertId')
listener_cert_id="${cert_id}-${PLATFORM_ALIYUN_REGION}"
aliyun alb UpdateListenerAttribute --RegionId "$PLATFORM_ALIYUN_REGION" \
  --ListenerId "$PLATFORM_CERT_ALB_LISTENER_ID" \
  --Certificates.1.CertificateId "$listener_cert_id" --force >/dev/null

for ip in "${alb_eips[@]}"; do
  ip="${ip// /}"
  curl --proto '=https' --tlsv1.2 -sS --resolve "$PLATFORM_CERT_DOMAIN:443:$ip" \
    "https://$PLATFORM_CERT_DOMAIN/healthz" -o /dev/null
  echo | openssl s_client -connect "$ip:443" -servername "$PLATFORM_CERT_DOMAIN" 2>/dev/null \
    | openssl x509 -checkend $((minimum_days * 86400)) -noout >/dev/null
done

tar -czf "$state_archive" -C "$acme_home" .
aliyun oss cp "$state_archive" "$state_uri" --region "$PLATFORM_ALIYUN_REGION" \
  --endpoint "$PLATFORM_CERT_OSS_ENDPOINT" --meta 'x-oss-server-side-encryption:AES256' --force >/dev/null

echo "platform certificate: renewed and activated certificate $listener_cert_id; previous certificate retained"
