import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const renewalScript = resolve(repoRoot, 'apps/platform/scripts/platform-certificate-renew.sh')
const script = readFileSync(renewalScript, 'utf8')
const workflow = yaml.load(readFileSync(resolve(repoRoot, '.github/workflows/platform-certificate-renew.yml'), 'utf8')) as Record<string, unknown>

const stateObject = 'certificate-renewal/platform/state.tar.gz'
const transactionKey = `${stateObject}.transaction.json`

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected record')
  return value as Record<string, unknown>
}

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o700)
}

interface RenewalOptions {
  deleteDnsFails?: boolean
  failCommit?: boolean
  fingerprintMismatch?: boolean
  servedFingerprint?: string
  unexpectedDns?: boolean
  ossUploadFails?: boolean
  listenerCert?: string
  tlsHandshakeFails?: boolean
  certificateParsingFails?: boolean
  seedTransaction?: Record<string, unknown>
  seedDnsRecords?: Array<{ RecordId: string; RR: string; Type: string }>
}

interface RenewalState {
  dir: string
  oss: string
  dnsDb: string
  runnerTemp: string
}

// Shared across runs of the same scenario: the mock OSS objects, the mock DNS
// database, and the runner-temp directory that receives protected local evidence.
function renewalState(existing?: string): RenewalState {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'certificate-renewal-state-'))
  const state: RenewalState = {
    dir,
    oss: join(dir, 'oss'),
    dnsDb: join(dir, 'dns-records.json'),
    runnerTemp: join(dir, 'runner-temp'),
  }
  mkdirSync(state.oss, { recursive: true })
  mkdirSync(state.runnerTemp, { recursive: true })
  if (!existsSync(state.dnsDb)) writeFileSync(state.dnsDb, '[]')
  return state
}

function storedTransaction(state: RenewalState): Record<string, unknown> {
  return JSON.parse(readFileSync(join(state.oss, transactionKey), 'utf8')) as Record<string, unknown>
}

function dnsRecords(state: RenewalState): Array<{ RecordId: string }> {
  return JSON.parse(readFileSync(state.dnsDb, 'utf8')) as Array<{ RecordId: string }>
}

function runRenewal(mode: 'validate' | 'renew', options: RenewalOptions = {}, state: RenewalState = renewalState()) {
  const root = mkdtempSync(join(tmpdir(), 'certificate-renewal-'))
  const bin = join(root, 'bin')
  const log = join(root, 'operations.log')
  const phases = join(root, 'phases.log')
  mkdirSync(bin, { recursive: true })
  writeFileSync(phases, '')
  if (options.seedTransaction) {
    const target = join(state.oss, transactionKey)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, JSON.stringify(options.seedTransaction))
  }
  if (options.seedDnsRecords) writeFileSync(state.dnsDb, JSON.stringify(options.seedDnsRecords))
  executable(join(bin, 'curl'), '#!/bin/bash\necho "curl $*" >> "$MOCK_LOG"\n: > "${@: -1}" 2>/dev/null || true\nexit 0\n')
  executable(join(bin, 'sha256sum'), '#!/bin/bash\nif [[ "$1" == -c ]]; then cat >/dev/null; exit 0; fi\necho "HASH  $1"\n')
  executable(join(bin, 'date'), '#!/bin/bash\ncase "$*" in *+%s*) echo ${MOCK_NOW:-1000};; *+%Y%m%d*) echo 20260905;; *-d*) echo 1000;; *) /bin/date "$@";; esac\n')
  executable(join(bin, 'openssl'), `#!/bin/bash\ncase "$1 $2" in
"s_client -connect")
 [[ "$MOCK_TLS_HANDSHAKE_FAIL" == 1 ]] && exit 7
 echo CERT;;
"x509 -in")
 [[ "$MOCK_CERTIFICATE_PARSING_FAIL" == 1 ]] && exit 8
 case "$*" in *-outform*) cat "$3";; *-enddate*) echo notAfter=Dec\\ 4\\ 16:29:23\\ 2026\\ GMT;; *-fingerprint*) [[ "$MOCK_FINGERPRINT_MISMATCH" == 1 && "$*" == *current/www.example.test-192.0.2.2.pem* ]] && echo SHA256\\ Fingerprint=OTHER || [[ "$*" == *current/* ]] && echo SHA256\\ Fingerprint=NEWFP || echo "SHA256 Fingerprint=\${MOCK_SERVED_FINGERPRINT:-NEWFP}";; *-pubkey*) echo PUB;; *-text*) printf 'X509v3 Subject Alternative Name:\\n    DNS:example.test, DNS:www.example.test\\n';; *-checkend*) exit 0;; esac;;
"pkey -in") echo PUB;;
esac\n`)
  executable(join(bin, 'cmp'), '#!/bin/bash\nexit 0\n')
  executable(join(bin, 'tar'), `#!/bin/bash\nif [[ "$1" == -xzf && "$*" == *acme-source* ]]; then
 out=""; prev=""; for arg in "$@"; do [[ "$prev" == -C ]] && out="$arg"; prev="$arg"; done
 mkdir -p "$out/dnsapi"
 cat > "$out/acme.sh" <<'ACME'
#!/bin/bash
home=; prev=; for arg in "$@"; do [[ "$prev" == --home ]] && home="$arg"; prev="$arg"; done
source "$(dirname "$0")/dnsapi/dns_gestalt_oidc.sh"
name="_acme-challenge.example.test"
[[ "$MOCK_UNEXPECTED_DNS" == 1 ]] && name="_acme-challenge.attacker.test"
dns_gestalt_oidc_add "$name" token || exit $?
mkdir -p "$home/www.example.test_ecc"
printf CERT-PEM-MATERIAL > "$home/www.example.test_ecc/fullchain.cer"
printf KEY-PEM-MATERIAL > "$home/www.example.test_ecc/www.example.test.key"
ACME
 chmod 700 "$out/acme.sh"
else /usr/bin/tar "$@"; fi
`)
  // The mock cloud is stateful across runs: OSS objects live in MOCK_OSS_DIR, DNS
  // records in MOCK_DNS_DB. The cas branch reproduces the pinned CLI 3.4.11 parser:
  // only the exact-case -FILE suffix reads file contents (openapi/rpc.go), the
  // lowercase -file spelling is rejected, and any other value is sent verbatim, so a
  // file:// URL would reach the "server" capture unchanged.
  executable(join(bin, 'aliyun'), `#!/bin/bash
echo "aliyun $*" >> "$MOCK_LOG"
object_path() { echo "$MOCK_OSS_DIR/\${1#oss://*/}"; }
case "$1 $2" in
"oss cp")
 if [[ "$3" == oss://* && "$4" != oss://* ]]; then
   src="$(object_path "$3")"
   if [[ -f "$src" ]]; then cp "$src" "$4"; exit 0; fi
   echo StatusCode=404 >&2; exit 1
 fi
 if [[ "$4" == oss://* ]]; then
   if [[ "$MOCK_OSS_UPLOAD_FAIL" == 1 ]]; then echo 'MockOssUnavailable: service unreachable' >&2; exit 9; fi
   if [[ "$4" == *transaction.json && "$MOCK_FAIL_COMMIT" == 1 ]] && grep -q '"phase":"committed"' "$3" 2>/dev/null; then echo 'MockCommitRejected' >&2; exit 9; fi
   dest="$(object_path "$4")"; mkdir -p "$(dirname "$dest")"; cp "$3" "$dest"
   if [[ "$4" == *transaction.json ]]; then jq -r .phase "$3" >> "$MOCK_PHASES"; fi
   exit 0
 fi
 exit 3;;
"alb GetListenerAttribute") printf '{"Certificates":[{"CertificateId":"%s"}]}' "$MOCK_LISTENER_CERT";;
"alb UpdateListenerAttribute") exit 0;;
"alidns AddDomainRecord")
 rr=; prev=; for a in "$@"; do [[ "$prev" == --RR ]] && rr="$a"; prev="$a"; done
 n=$(( $(cat "$MOCK_DNS_DB.seq" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$MOCK_DNS_DB.seq"
 jq --arg id "record-$n" --arg rr "$rr" '. + [{RecordId:$id, RR:$rr, Type:"TXT"}]' "$MOCK_DNS_DB" > "$MOCK_DNS_DB.tmp" && mv "$MOCK_DNS_DB.tmp" "$MOCK_DNS_DB"
 printf '{"RecordId":"record-%s"}' "$n";;
"alidns DeleteDomainRecord")
 rid=; prev=; for a in "$@"; do [[ "$prev" == --RecordId ]] && rid="$a"; prev="$a"; done
 if [[ "$MOCK_DELETE_DNS_FAILS" == 1 ]]; then echo 'MockDeleteFailed' >&2; exit 8; fi
 if jq -e --arg id "$rid" 'map(select(.RecordId == $id)) | length > 0' "$MOCK_DNS_DB" >/dev/null; then
   jq --arg id "$rid" 'map(select(.RecordId != $id))' "$MOCK_DNS_DB" > "$MOCK_DNS_DB.tmp" && mv "$MOCK_DNS_DB.tmp" "$MOCK_DNS_DB"
   exit 0
 fi
 echo 'InvalidRecordId.NotFound: The specified record id does not exist' >&2; exit 6;;
"alidns DescribeDomainRecords")
 kw=; prev=; for a in "$@"; do [[ "$prev" == --RRKeyWord ]] && kw="$a"; prev="$a"; done
 jq --arg kw "$kw" '{DomainRecords:{Record: map(select(.Type == "TXT" and (.RR | contains($kw))))}}' "$MOCK_DNS_DB";;
"cas UploadUserCertificate")
 cert=; key=; prev=
 for a in "$@"; do
   case "$a" in --Cert-file|--Key-file) echo "ERROR: '$a' is not a valid parameter or flag." >&2; exit 2;; esac
   case "$prev" in
     --Cert-FILE) cert=$(cat "$a") || exit 1;;
     --Key-FILE) key=$(cat "$a") || exit 1;;
     --Cert) cert="$a";;
     --Key) key="$a";;
   esac
   prev="$a"
 done
 printf '%s' "$cert" > "$MOCK_CAS_CAPTURE.cert"; printf '%s' "$key" > "$MOCK_CAS_CAPTURE.key"
 echo '{"CertId":"new-cert"}';;
esac
`)
  const result = spawnSync('bash', [renewalScript, mode], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`, MOCK_LOG: log, MOCK_PHASES: phases,
      MOCK_OSS_DIR: state.oss, MOCK_DNS_DB: state.dnsDb,
      MOCK_CAS_CAPTURE: join(root, 'cas-capture'),
      MOCK_LISTENER_CERT: options.listenerCert ?? 'prior-cn-hangzhou',
      MOCK_SERVED_FINGERPRINT: options.servedFingerprint ?? 'NEWFP',
      MOCK_NOW: mode === 'renew' ? '2000' : '1000',
      MOCK_FAIL_COMMIT: options.failCommit ? '1' : '0', MOCK_UNEXPECTED_DNS: options.unexpectedDns ? '1' : '0',
      MOCK_FINGERPRINT_MISMATCH: options.fingerprintMismatch ? '1' : '0',
      MOCK_TLS_HANDSHAKE_FAIL: options.tlsHandshakeFails ? '1' : '0',
      MOCK_CERTIFICATE_PARSING_FAIL: options.certificateParsingFails ? '1' : '0',
      MOCK_DELETE_DNS_FAILS: options.deleteDnsFails ? '1' : '0',
      MOCK_OSS_UPLOAD_FAIL: options.ossUploadFails ? '1' : '0',
      RUNNER_TEMP: state.runnerTemp,
      PLATFORM_ALIYUN_REGION: 'cn-hangzhou', PLATFORM_CERT_DOMAIN: 'example.test',
      PLATFORM_CERT_WWW_DOMAIN: 'www.example.test', PLATFORM_CERT_ALB_EIPS: '192.0.2.1,192.0.2.2',
      PLATFORM_CERT_ALB_LISTENER_ID: 'lsn-test123', PLATFORM_CERT_OSS_BUCKET: 'private-bucket',
      PLATFORM_CERT_OSS_ENDPOINT: 'oss.example.test', PLATFORM_CERT_STATE_OBJECT: stateObject,
      PLATFORM_CERT_RENEW_BEFORE_DAYS: '30', PLATFORM_CERT_MINIMUM_VALID_DAYS: '60',
      ACME_ARCHIVE_URL: 'https://example.test/acme.tar.gz', ACME_ARCHIVE_SHA256: 'abc',
    },
  })
  return {
    ...result,
    state,
    operations: readFileSync(log, 'utf8'),
    phases: readFileSync(phases, 'utf8').split('\n').filter(Boolean),
    capturedCert: existsSync(`${join(root, 'cas-capture')}.cert`) ? readFileSync(`${join(root, 'cas-capture')}.cert`, 'utf8') : null,
    capturedKey: existsSync(`${join(root, 'cas-capture')}.key`) ? readFileSync(`${join(root, 'cas-capture')}.key`, 'utf8') : null,
  }
}

function listenerUpdates(operations: string): string[] {
  return operations.split('\n').filter(line => line.includes('alb UpdateListenerAttribute'))
}

describe('Platform certificate renewal automation', () => {
  it('gates the OIDC job before it receives production authority', () => {
    const jobs = record(workflow.jobs)
    const enabled = record(jobs.enabled)
    const renew = record(jobs.renew)
    expect(enabled.environment).toBeUndefined()
    expect(record(renew.permissions)).toEqual({ contents: 'read', 'id-token': 'write' })
    expect(renew.needs).toBe('enabled')
    expect(renew.if).toBe("needs.enabled.outputs.enabled == 'true'")
    const source = JSON.stringify(enabled)
    expect(source).toContain('PLATFORM_CERT_RENEWAL_ENABLED')
    expect(source).toContain('refs/heads/master')
    expect(source).toContain('merge-base --is-ancestor')
    expect(record(workflow.env)).toEqual({
      ALIYUN_CLI_VERSION: '3.4.11',
      ALIYUN_CLI_LINUX_AMD64_SHA256: 'a7e3df497db14c10d4d7587795e9fa7849b0c51dfce02908b9de5a41fe717d5c',
    })
  })

  it('uploads sanitized local cleanup evidence as a run artifact on failure', () => {
    const renew = record(record(workflow.jobs).renew)
    const steps = renew.steps as Array<Record<string, unknown>>
    const upload = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    expect(upload).toBeDefined()
    expect(upload?.if).toBe('failure()')
    const inputs = record(upload?.with)
    expect(String(inputs.path)).toBe('${{ runner.temp }}/platform-certificate-renewal-cleanup-evidence.json')
    expect(inputs['if-no-files-found']).toBe('ignore')
    expect(inputs['retention-days']).toBe(30)
    expect(String(inputs.name)).toContain('run_id')
  })

  it('validates current TLS when s_client exits without reading stdin', () => {
    const result = runRenewal('validate')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('validation passed')
    expect(result.operations).not.toMatch(/AddDomainRecord|DeleteDomainRecord|DescribeDomainRecords/)
    expect(result.operations).not.toMatch(/UploadUserCertificate|UpdateListenerAttribute|AES256/)
    expect(script).not.toContain('echo | openssl s_client')
    expect(script).toContain('openssl s_client -connect "$ip:443" -servername "$host" </dev/null > "$destination"')
  })

  it('fails validation when the TLS handshake fails', () => {
    const result = runRenewal('validate', { tlsHandshakeFails: true })
    expect(result.status).not.toBe(0)
  })

  it('fails validation when the served certificate cannot be parsed', () => {
    const result = runRenewal('validate', { certificateParsingFails: true })
    expect(result.status).not.toBe(0)
  })

  it('rejects a different current leaf even when its expiry matches', () => {
    const result = runRenewal('validate', { fingerprintMismatch: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('different certificates')
  })

  it('reports an issued transaction without mutation in validate mode', () => {
    const result = runRenewal('validate', {
      seedTransaction: { version: 1, phase: 'issued', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: 'new-cert-cn-hangzhou', fingerprint: 'NEWFP', cleanupRecordIds: [] },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pending issued transaction')
    expect(result.operations).not.toContain('AddDomainRecord')
    expect(result.operations).not.toContain('UpdateListenerAttribute')
  })

  it('reports pending challenge cleanup without mutation in validate mode', () => {
    const result = runRenewal('validate', {
      seedTransaction: { version: 1, phase: 'cleanup-pending', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: '', fingerprint: '', cleanupRecordIds: ['record-7'] },
      seedDnsRecords: [{ RecordId: 'record-7', RR: '_acme-challenge', Type: 'TXT' }],
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pending challenge cleanup')
    expect(result.operations).not.toMatch(/AddDomainRecord|DeleteDomainRecord|UploadUserCertificate|UpdateListenerAttribute/)
    expect(dnsRecords(result.state)).toHaveLength(1)
    expect(storedTransaction(result.state).phase).toBe('cleanup-pending')
  })

  it('reconciles an issued transaction without reissuing a certificate', () => {
    const result = runRenewal('renew', {
      seedTransaction: { version: 1, phase: 'issued', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: 'new-cert-cn-hangzhou', fingerprint: 'NEWFP', cleanupRecordIds: [] },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('reconciled issued certificate')
    expect(result.operations).not.toContain('AddDomainRecord')
    expect(result.operations).not.toContain('UploadUserCertificate')
    expect(result.operations).toContain('UpdateListenerAttribute')
    const committed = storedTransaction(result.state)
    expect(committed.phase).toBe('committed')
    expect(committed.cleanupRecordIds).toEqual([])
  }, 15_000)

  it('restores the recorded prior certificate when an already-active candidate fails verification', () => {
    const result = runRenewal('renew', {
      seedTransaction: { version: 1, phase: 'issued', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: 'new-cert-cn-hangzhou', fingerprint: 'NEWFP', cleanupRecordIds: [] },
      listenerCert: 'new-cert-cn-hangzhou',
      servedFingerprint: 'OTHER',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('did not reach every name and EIP')
    const updates = listenerUpdates(result.operations)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain('prior-cn-hangzhou')
    expect(storedTransaction(result.state).phase).toBe('issued')
  }, 15_000)

  it('restores the recorded prior certificate when the reconciliation commit fails', () => {
    const result = runRenewal('renew', {
      seedTransaction: { version: 1, phase: 'issued', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: 'new-cert-cn-hangzhou', fingerprint: 'NEWFP', cleanupRecordIds: [] },
      listenerCert: 'new-cert-cn-hangzhou',
      failCommit: true,
    })
    expect(result.status).not.toBe(0)
    const updates = listenerUpdates(result.operations)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain('prior-cn-hangzhou')
    expect(storedTransaction(result.state).phase).toBe('issued')
  }, 15_000)

  it('retries recorded challenge ids from an issued transaction instead of copying them into the commit', () => {
    const result = runRenewal('renew', {
      seedTransaction: { version: 1, phase: 'issued', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: 'new-cert-cn-hangzhou', fingerprint: 'NEWFP', cleanupRecordIds: ['record-9'] },
      seedDnsRecords: [{ RecordId: 'record-9', RR: '_acme-challenge', Type: 'TXT' }],
      listenerCert: 'new-cert-cn-hangzhou',
    })
    expect(result.status).toBe(0)
    expect(result.operations).toContain('DeleteDomainRecord --RegionId cn-hangzhou --RecordId record-9')
    expect(dnsRecords(result.state)).toHaveLength(0)
    const committed = storedTransaction(result.state)
    expect(committed.phase).toBe('committed')
    expect(committed.cleanupRecordIds).toEqual([])
  }, 15_000)

  it('recovers a pending cleanup transaction on the next run, deletes its records, and closes it', () => {
    const state = renewalState()
    const first = runRenewal('renew', { deleteDnsFails: true }, state)
    expect(first.status).not.toBe(0)
    const pending = storedTransaction(state)
    expect(pending.phase).toBe('cleanup-pending')
    expect(pending.cleanupRecordIds).toEqual(['record-1'])
    expect(dnsRecords(state)).toHaveLength(1)

    const second = runRenewal('renew', {}, state)
    expect(second.status).toBe(0)
    expect(second.operations).toContain('DeleteDomainRecord --RegionId cn-hangzhou --RecordId record-1')
    expect(second.phases[0]).toBe('committed')
    expect(dnsRecords(state)).toHaveLength(0)
    expect(storedTransaction(state).phase).toBe('committed')
  }, 30_000)

  it('persists every added challenge record to the transaction object before activation', () => {
    const result = runRenewal('renew')
    expect(result.status).toBe(0)
    expect(result.phases).toEqual(['cleanup-pending', 'issued', 'committed'])
    expect(result.phases.indexOf('cleanup-pending')).toBeLessThan(result.phases.indexOf('issued'))
  }, 15_000)

  it('uploads the renewed certificate through parser-supported file flags without exposing key material', () => {
    const result = runRenewal('renew')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('renewed and activated')
    expect(result.operations).toContain('--Cert-FILE')
    expect(result.operations).toContain('--Key-FILE')
    expect(result.operations).not.toContain('file://')
    expect(result.operations).not.toContain('CERT-PEM-MATERIAL')
    expect(result.operations).not.toContain('KEY-PEM-MATERIAL')
    // The mock cas endpoint captures what the pinned CLI parser would put on the
    // wire: file contents for -FILE flags, or the verbatim bad value otherwise.
    expect(result.capturedCert).toBe('CERT-PEM-MATERIAL')
    expect(result.capturedKey).toBe('KEY-PEM-MATERIAL')
    expect(storedTransaction(result.state).currentCertificateId).toBe('new-cert-cn-hangzhou')
  }, 15_000)

  it('persists failed DNS cleanup evidence to the transaction object', () => {
    const result = runRenewal('renew', { deleteDnsFails: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('durable transaction evidence')
    expect(result.operations).toContain('transaction.json')
    expect(result.operations).toContain('DeleteDomainRecord')
    const pending = storedTransaction(result.state)
    expect(pending.phase).toBe('cleanup-pending')
    expect(pending.cleanupRecordIds).toEqual(['record-1'])
  }, 15_000)

  it('deletes only durably recorded challenge ids and preserves unknown records at the same name', () => {
    const result = runRenewal('renew', {
      seedTransaction: { version: 1, phase: 'cleanup-pending', priorCertificateId: 'prior-cn-hangzhou', currentCertificateId: '', fingerprint: '', cleanupRecordIds: ['record-1'] },
      seedDnsRecords: [
        { RecordId: 'record-1', RR: '_acme-challenge', Type: 'TXT' },
        { RecordId: 'record-x', RR: '_acme-challenge', Type: 'TXT' },
      ],
    })
    expect(result.status).toBe(0)
    expect(result.operations).toContain('DeleteDomainRecord --RegionId cn-hangzhou --RecordId record-1')
    expect(result.operations).not.toContain('RecordId record-x')
    expect(dnsRecords(result.state).map(entry => entry.RecordId)).toEqual(['record-x'])
  }, 15_000)

  it('retains protected local evidence with sanitized failure metadata when OSS is unavailable', () => {
    const state = renewalState()
    const result = runRenewal('renew', { deleteDnsFails: true, ossUploadFails: true }, state)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('protected local evidence')
    expect(result.stderr).not.toContain('durable transaction evidence')
    const evidencePath = join(state.runnerTemp, 'platform-certificate-renewal-cleanup-evidence.json')
    expect(existsSync(evidencePath)).toBe(true)
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<string, unknown>
    expect(evidence.phase).toBe('cleanup-pending')
    expect(evidence.cleanupRecordIds).toEqual(['record-1'])
    // The artifact is reader-accessible, so the evidence carries only sanitized
    // metadata — status, count, hash — and never raw command output.
    expect(evidence.recordCount).toBe(1)
    expect(typeof evidence.recordIdsSha256).toBe('string')
    expect(evidence.evidenceUploadStatus).toBe(9)
    expect(JSON.stringify(evidence)).not.toContain('MockOssUnavailable')
    expect(dnsRecords(state)).toHaveLength(1)
  }, 15_000)

  it('refuses a DNS challenge outside the two exact allowed names', () => {
    const result = runRenewal('renew', { unexpectedDns: true })
    expect(result.status).not.toBe(0)
    expect(result.operations).not.toContain('AddDomainRecord')
    expect(result.operations).not.toContain('UploadUserCertificate')
  }, 15_000)

  it('restores the prior listener when the committed metadata write fails', () => {
    const result = runRenewal('renew', { failCommit: true })
    expect(result.status).not.toBe(0)
    const updates = listenerUpdates(result.operations)
    expect(updates).toHaveLength(2)
    expect(updates[0]).toContain('new-cert-cn-hangzhou')
    expect(updates[1]).toContain('prior-cn-hangzhou')
  }, 15_000)

  it('maps INT and TERM cleanup handlers to nonzero exits', () => {
    expect(script).toContain("trap 'trap - EXIT; on_exit 130' INT")
    expect(script).toContain("trap 'trap - EXIT; on_exit 143' TERM")
  })

  it('pins ACME, uses OSS AES256, and never embeds reusable cloud credentials', () => {
    const source = JSON.stringify(workflow)
    expect(source).toContain('3661fd86b6304115e42f43910e6dd452ab9866d6')
    expect(source).toContain('9af3ad3d775a5782246df4cdd4b4e7b9b3179deb63c509b10e3ba0433093a884')
    expect(source).not.toMatch(/ACCESS_KEY|ACCESSKEY|Ali_Key|Ali_Secret|PLATFORM_CERT_STATE_KEY/)
    expect(script).toContain("--meta 'x-oss-server-side-encryption:AES256'")
    expect(script).not.toContain('DeleteUserCertificate')
  })
})
