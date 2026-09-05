import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const script = readFileSync(resolve(repoRoot, 'apps/platform/scripts/platform-certificate-renew.sh'), 'utf8')
const workflow = yaml.load(
  readFileSync(resolve(repoRoot, '.github/workflows/platform-certificate-renew.yml'), 'utf8'),
) as Record<string, unknown>

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected record')
  return value as Record<string, unknown>
}

describe('Platform certificate renewal automation', () => {
  it('uses the production OIDC identity without a permanent Alibaba Cloud credential', () => {
    const jobs = record(workflow.jobs)
    const renew = record(jobs.renew)
    expect(renew.environment).toBe('production')
    expect(record(renew.permissions)).toEqual({ contents: 'read', 'id-token': 'write' })
    const source = JSON.stringify(workflow)
    expect(source).toContain('PLATFORM_ALIYUN_DEPLOY_ROLE_ARN')
    expect(source).toContain('PLATFORM_ALIYUN_OIDC_PROVIDER_ARN')
    expect(source).not.toMatch(/ACCESS_KEY|ACCESSKEY|Ali_Key|Ali_Secret/)
  })

  it('pins and verifies the ACME source before execution', () => {
    expect(script).toContain('printf \'%s  %s\\n\' "$ACME_ARCHIVE_SHA256" "$archive" | sha256sum -c -')
    expect(JSON.stringify(workflow)).toContain('3661fd86b6304115e42f43910e6dd452ab9866d6')
    expect(JSON.stringify(workflow)).toContain('9af3ad3d775a5782246df4cdd4b4e7b9b3179deb63c509b10e3ba0433093a884')
    expect(JSON.stringify(workflow)).not.toContain('get.acme.sh')
  })

  it('validates without renewal and renews scheduled runs only when due', () => {
    expect(script).toContain('if [ "$mode" = validate ] || [ "$now" -lt "$due_at" ]')
    expect(script).toContain('current certificate is not due; validation passed')
    expect(script).toContain('--renew -d "$PLATFORM_CERT_WWW_DOMAIN" --ecc --force')
    expect(JSON.stringify(workflow)).toContain("github.event_name == 'schedule' && 'renew' || inputs.mode")
  })

  it('uses private OSS AES256 at rest and owner-only runner state without a reusable secret', () => {
    expect(script).toContain('umask 077')
    expect(script).toContain('chmod 700 "$workdir"')
    expect(script).toContain("--meta 'x-oss-server-side-encryption:AES256'")
    expect(script).not.toContain('PLATFORM_CERT_STATE_KEY')
    expect(script).not.toContain('openssl enc')
    expect(script).not.toContain('set -x')
    expect(JSON.stringify(workflow)).not.toContain('PLATFORM_CERT_STATE_KEY')
  })

  it('cleans DNS records and validates certificate identity before the listener update', () => {
    const cleanup = script.indexOf('cleanup_dns()')
    const san = script.indexOf('[ "$san" = "$expected_a" ]')
    const lifetime = script.indexOf('openssl x509 -in "$cert" -checkend')
    const update = script.indexOf('aliyun alb UpdateListenerAttribute')
    expect(cleanup).toBeGreaterThan(-1)
    expect(san).toBeGreaterThan(cleanup)
    expect(lifetime).toBeGreaterThan(san)
    expect(update).toBeGreaterThan(lifetime)
    expect(script).toContain('aliyun alidns DeleteDomainRecord')
    expect(script).toContain('certificate and key differ')
    expect(script).toContain('unexpected SAN set')
  })

  it('updates only the configured listener and retains the previous certificate', () => {
    expect(script).toContain('--ListenerId "$PLATFORM_CERT_ALB_LISTENER_ID"')
    expect(script).toContain('--Certificates.1.CertificateId "$listener_cert_id" --force')
    expect(script).toContain('--Cert "file://$cert" --Key "file://$key"')
    expect(script).toContain('previous certificate retained')
    expect(script).not.toContain('DeleteUserCertificate')
    expect(script).not.toContain('DeleteLoadBalancer')
    expect(script).not.toContain('ReleaseInstance')
  })
})
