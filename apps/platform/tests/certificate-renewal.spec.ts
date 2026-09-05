import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const renewalScript = resolve(repoRoot, 'apps/platform/scripts/platform-certificate-renew.sh')
const script = readFileSync(renewalScript, 'utf8')
const workflow = yaml.load(readFileSync(resolve(repoRoot, '.github/workflows/platform-certificate-renew.yml'), 'utf8')) as Record<string, unknown>

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected record')
  return value as Record<string, unknown>
}

function executable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o700)
}

function runRenewal(mode: 'validate' | 'renew', options: { deleteDnsFails?: boolean; failCommit?: boolean; fingerprintMismatch?: boolean; issuedTransaction?: boolean; unexpectedDns?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'certificate-renewal-'))
  const bin = join(root, 'bin')
  const log = join(root, 'operations.log')
  spawnSync('mkdir', ['-p', bin])
  executable(join(bin, 'curl'), '#!/bin/bash\necho "curl $*" >> "$MOCK_LOG"\n: > "${@: -1}" 2>/dev/null || true\nexit 0\n')
  executable(join(bin, 'sha256sum'), '#!/bin/bash\nif [[ "$1" == -c ]]; then cat >/dev/null; exit 0; fi\necho "HASH  $1"\n')
  executable(join(bin, 'date'), '#!/bin/bash\ncase "$*" in *+%s*) echo ${MOCK_NOW:-1000};; *+%Y%m%d*) echo 20260905;; *-d*) echo 1000;; *) /bin/date "$@";; esac\n')
  executable(join(bin, 'openssl'), `#!/bin/bash\ncase "$1 $2" in
"s_client -connect") echo CERT;;
"x509 -outform") cat;;
"x509 -noout") echo SHA256\ Fingerprint=NEWFP; cat >/dev/null;;
"x509 -in")
 case "$*" in *-enddate*) echo notAfter=Dec\ 4\ 16:29:23\ 2026\ GMT;; *-fingerprint*) [[ "$MOCK_FINGERPRINT_MISMATCH" == 1 && "$*" == *current/www.example.test-192.0.2.2.pem* ]] && echo SHA256\ Fingerprint=OTHER || echo SHA256\ Fingerprint=NEWFP;; *-pubkey*) echo PUB;; *-text*) printf 'X509v3 Subject Alternative Name:\n    DNS:example.test, DNS:www.example.test\n';; *-checkend*) exit 0;; esac;;
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
printf CERT > "$home/www.example.test_ecc/fullchain.cer"
printf KEY > "$home/www.example.test_ecc/www.example.test.key"
ACME
 chmod 700 "$out/acme.sh"
else /usr/bin/tar "$@"; fi
`)
  executable(join(bin, 'aliyun'), `#!/bin/bash
echo "aliyun $*" >> "$MOCK_LOG"
case "$1 $2" in
"oss cp")
 if [[ "$3" == oss://* && "$4" != oss://* ]]; then
   if [[ "$3" == *transaction.json && "$MOCK_ISSUED_TRANSACTION" == 1 ]]; then printf '{"version":1,"phase":"issued","priorCertificateId":"prior-cn-hangzhou","currentCertificateId":"new-cert-cn-hangzhou","fingerprint":"NEWFP","cleanupRecordIds":[]}' > "$4"; exit 0; fi
   echo StatusCode=404 >&2; exit 1
 fi
 if [[ "$4" == *transaction.json && "$MOCK_FAIL_COMMIT" == 1 ]] && grep -q committed "$3" 2>/dev/null; then exit 9; fi;;
"alb GetListenerAttribute") if [[ "$MOCK_ISSUED_TRANSACTION" == 1 ]]; then echo '{"Certificates":[{"CertificateId":"prior-cn-hangzhou"}]}'; else echo '{"Certificates":[{"CertificateId":"prior-cn-hangzhou"}]}'; fi ;;
"alidns AddDomainRecord") echo '{"RecordId":"record-1"}' ;;
"alidns DeleteDomainRecord") [[ "$MOCK_DELETE_DNS_FAILS" == 1 ]] && exit 8 || exit 0 ;;
"cas UploadUserCertificate") echo '{"CertId":"new-cert"}' ;;
"alb UpdateListenerAttribute") exit 0 ;;
esac
`)
  const result = spawnSync('bash', [renewalScript, mode], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`, MOCK_LOG: log,
      MOCK_NOW: mode === 'renew' ? '2000' : '1000',
      MOCK_FAIL_COMMIT: options.failCommit ? '1' : '0', MOCK_UNEXPECTED_DNS: options.unexpectedDns ? '1' : '0',
      MOCK_FINGERPRINT_MISMATCH: options.fingerprintMismatch ? '1' : '0',
      MOCK_ISSUED_TRANSACTION: options.issuedTransaction ? '1' : '0',
      MOCK_DELETE_DNS_FAILS: options.deleteDnsFails ? '1' : '0',
      PLATFORM_ALIYUN_REGION: 'cn-hangzhou', PLATFORM_CERT_DOMAIN: 'example.test',
      PLATFORM_CERT_WWW_DOMAIN: 'www.example.test', PLATFORM_CERT_ALB_EIPS: '192.0.2.1,192.0.2.2',
      PLATFORM_CERT_ALB_LISTENER_ID: 'lsn-test123', PLATFORM_CERT_OSS_BUCKET: 'private-bucket',
      PLATFORM_CERT_OSS_ENDPOINT: 'oss.example.test', PLATFORM_CERT_STATE_OBJECT: 'certificate-renewal/platform/state.tar.gz',
      PLATFORM_CERT_RENEW_BEFORE_DAYS: '30', PLATFORM_CERT_MINIMUM_VALID_DAYS: '60',
      ACME_ARCHIVE_URL: 'https://example.test/acme.tar.gz', ACME_ARCHIVE_SHA256: 'abc',
    },
  })
  return { ...result, operations: readFileSync(log, 'utf8') }
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

  it('validates current TLS without DNS, CAS, listener, or state writes', () => {
    const result = runRenewal('validate')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('validation passed')
    expect(result.operations).not.toMatch(/AddDomainRecord|UploadUserCertificate|UpdateListenerAttribute|AES256/)
  })

  it('rejects a different current leaf even when its expiry matches', () => {
    const result = runRenewal('validate', { fingerprintMismatch: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('different certificates')
  })

  it('reports an issued transaction without mutation in validate mode', () => {
    const result = runRenewal('validate', { issuedTransaction: true })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pending issued transaction')
    expect(result.operations).not.toContain('AddDomainRecord')
    expect(result.operations).not.toContain('UpdateListenerAttribute')
  })

  it('reconciles an issued transaction without reissuing a certificate', () => {
    const result = runRenewal('renew', { issuedTransaction: true })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('reconciled issued certificate')
    expect(result.operations).not.toContain('AddDomainRecord')
    expect(result.operations).not.toContain('UploadUserCertificate')
    expect(result.operations).toContain('UpdateListenerAttribute')
  }, 15_000)

  it('persists failed DNS cleanup evidence to the transaction object', () => {
    const result = runRenewal('renew', { deleteDnsFails: true })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('durable transaction evidence')
    expect(result.operations).toContain('transaction.json')
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
    const updates = result.operations.split('\n').filter(line => line.includes('alb UpdateListenerAttribute'))
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
