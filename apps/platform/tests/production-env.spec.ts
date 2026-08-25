import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  PLATFORM_DEPLOY_REQUIRED_ENV,
  PLATFORM_PRODUCTION_REQUIRED_ENV,
  assertOperatedPlatformEnvironment,
  loadOperatedPlatformConfig,
  missingPlatformDeployEnv,
  missingPlatformProductionEnv,
  readPlatformSigningKey,
  requiredPlatformEnv,
  runPlatformProductionEnvCli,
  validatePlatformEcsInstanceIds,
} from '../src/production-env.ts'

const HEX = 'ab'.repeat(32)
const DISTINCTIVE_SECRET = 'super-secret-token-value-do-not-print'
const APSARADB_CA = readFileSync(new URL('../../../packages/platform/remote-access-http/tests/fixtures/localhost-cert.pem', import.meta.url), 'utf8')
const LEAF_CERTIFICATE = readFileSync(new URL('./fixtures/leaf-cert.pem', import.meta.url), 'utf8')
const script = fileURLToPath(new URL('../src/production-env-cli.ts', import.meta.url))
const bootSource = readFileSync(new URL('../src/boot.ts', import.meta.url), 'utf8')
const launchSource = readFileSync(new URL('../src/launch.ts', import.meta.url), 'utf8')
const remoteAccessResourcesSource = readFileSync(new URL('../src/remote-access-resources.ts', import.meta.url), 'utf8')
const dockerfileSource = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const publicReadinessScript = fileURLToPath(new URL('../scripts/platform-public-readiness.sh', import.meta.url))
const publicReadinessSource = readFileSync(publicReadinessScript, 'utf8')
const cloudAssistantSource = readFileSync(new URL('../scripts/platform-cloud-assistant.sh', import.meta.url), 'utf8')
const hostDeploySource = readFileSync(new URL('../scripts/platform-host-deploy.sh', import.meta.url), 'utf8')
const recoveryScript = fileURLToPath(new URL('../scripts/platform-recover.sh', import.meta.url))
const recoverySource = readFileSync(recoveryScript, 'utf8')
const repoRoot = resolve(import.meta.dirname, '../../..')

function bashPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return filePath
  return filePath
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`)
}

function shellLogicalLines(source: string): string[] {
  return source.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
}

function completeDeployEnv(): NodeJS.Dict<string> {
  return {
    PLATFORM_ORIGIN: 'https://platform.example.test',
    PLATFORM_GITHUB_CLIENT_ID: 'client',
    PLATFORM_GITHUB_CLIENT_SECRET: DISTINCTIVE_SECRET,
    PLATFORM_GITHUB_CALLBACK: 'https://platform.example.test/v1/account/oauth/github/callback',
    PLATFORM_GITHUB_CREDENTIAL_REFERENCE: 'credentials://github-oauth/production',
    PLATFORM_POSTGRES_HOST: 'postgres.example.test',
    PLATFORM_POSTGRES_USER: 'gestalt',
    PLATFORM_POSTGRES_PASSWORD: DISTINCTIVE_SECRET,
    PLATFORM_APSARADB_CA_BASE64: Buffer.from(APSARADB_CA).toString('base64'),
    PLATFORM_POSTGRES_DATABASE: 'gestalt',
    PLATFORM_IDENTITY_NAMESPACE: 'gestalt-production',
    PLATFORM_REDIS_HOST: 'redis.example.test',
    PLATFORM_REDIS_USER: 'gestalt',
    PLATFORM_REDIS_PASSWORD: DISTINCTIVE_SECRET,
    PLATFORM_OSS_ENDPOINT: 'oss-cn-hangzhou-internal.aliyuncs.com',
    PLATFORM_OSS_BUCKET: 'gestalt-secret',
    PLATFORM_OSS_AUTH: 'ecs-ram-role/gestalt-vpc',
    PLATFORM_OSS_OBJECT_PREFIX: 'remote-attachments/production',
    PLATFORM_OSS_TIMEOUT_MS: '10000',
    PLATFORM_RELAY_REDIS_KEY_PREFIX: 'gestalt:relay',
    PLATFORM_RELAY_INSTANCE_ID: 'platform-production',
    PLATFORM_RELAY_CAPACITY_RETRY_AFTER_MS: '1000',
    PLATFORM_RELAY_DELIVERY_ACK_TIMEOUT_MS: '5000',
    PLATFORM_RELAY_DIRECTORY_TTL_MS: '60000',
    PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS: '45000',
    PLATFORM_RELAY_MAX_BUFFERED_CIPHERTEXT_BYTES: '1048576',
    PLATFORM_RELAY_MAX_CONNECTIONS: '10000',
    PLATFORM_RELAY_MAX_PENDING_DELIVERIES: '10000',
    PLATFORM_RELAY_MAX_PENDING_CHALLENGES: '10000',
    PLATFORM_RELAY_ATTACH_TIMEOUT_MS: '10000',
    PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES: '104857600',
    PLATFORM_REMOTE_ATTACHMENT_CAPABILITY_LIFETIME_MS: '900000',
    PLATFORM_REMOTE_ATTACHMENT_MAX_RETAINED_BLOBS: '10000',
    PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'oss',
    PLATFORM_REMOTE_ATTACHMENT_SWEEP_INTERVAL_MS: '60000',
    PLATFORM_REMOTE_ATTACHMENT_CLEANUP_CONCURRENCY: '8',
    PLATFORM_TOKEN_SIGNING_KEY: HEX,
    PLATFORM_POLLING_SIGNING_KEY: HEX,
    PLATFORM_ALIYUN_REGION: 'cn-hangzhou',
    PLATFORM_ALIYUN_OIDC_PROVIDER_ARN: 'acs:ram::123456789:oidc-provider/gestalt-github-actions',
    PLATFORM_ALIYUN_DEPLOY_ROLE_ARN: 'acs:ram::123456789:role/gestalt-platform-deploy',
    PLATFORM_ECS_INSTANCE_IDS: 'i-first123,i-second456',
    PLATFORM_ALB_SERVER_GROUP_ID: 'sgp-production123',
    PLATFORM_DEPLOY_OSS_UPLOAD_ENDPOINT: 'oss-cn-hangzhou.aliyuncs.com',
    PLATFORM_DEPLOY_OSS_OBJECT_PREFIX: 'deploy-artifacts/platform',
  }
}

function spawnCli(env: NodeJS.Dict<string>) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TSX_TSCONFIG_PATH: resolve(repoRoot, 'tsconfig.json'),
      ...(process.platform === 'win32'
        ? {
          SYSTEMROOT: process.env.SYSTEMROOT,
          PATHEXT: process.env.PATHEXT,
          COMSPEC: process.env.COMSPEC,
        }
        : {}),
      ...env,
    },
  })
}

function runPublicReadinessHarness(
  result: 'success' | 'one-backend' | 'redirect' | 'unreachable' | 'wrong-storage',
) {
  const harness = [
    'set -eEuo pipefail',
    'instance_ids=(i-first123 i-second456)',
    'READINESS_COUNTER=$(mktemp)',
    'node() {',
    '  if [ "$READINESS_RESULT" = unreachable ] || [ "$READINESS_RESULT" = redirect ]; then return 22; fi',
    '  count=$(cat "$READINESS_COUNTER")',
    '  count=$((count + 1))',
    '  printf \'%s\' "$count" > "$READINESS_COUNTER"',
    '  if [ "$READINESS_RESULT" = wrong-storage ]; then',
    '    printf \'{"attachmentStorage":"postgres","instanceId":"relay-1"}\'',
    '  elif [ "$READINESS_RESULT" = one-backend ] || [ "$count" = 1 ]; then',
    '    printf \'{"attachmentStorage":"oss","instanceId":"relay-1"}\'',
    '  else',
    '    printf \'{"attachmentStorage":"oss","instanceId":"relay-2"}\'',
    '  fi',
    '}',
    'sleep() { :; }',
    publicReadinessSource,
    'platform_public_readiness 2',
    'printf \'CLEANUP\\n\'',
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      PLATFORM_ORIGIN: 'https://platform.example.test',
      PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'oss',
      READINESS_RESULT: result,
    },
  })
}

function runPublicHttpsGet(url: string): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('bash', ['-c', 'source "$PUBLIC_READINESS_SCRIPT"; platform_https_get "$READINESS_URL"'], {
      env: {
        PATH: process.env.PATH,
        PUBLIC_READINESS_SCRIPT: bashPath(publicReadinessScript),
        READINESS_URL: url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('close', (status) => { resolvePromise({ status, stderr, stdout }) })
  })
}

function runCloudAssistantHarness(result: 'success' | 'failure') {
  const harness = [
    'set -eEuo pipefail',
    'STATE=$(mktemp)',
    'printf 0 > "$STATE"',
    'aliyun() {',
    '  case "$2" in',
    '    RunCommand) printf \'{"InvokeId":"invoke-test"}\' ;;',
    '    DescribeInvocationResults)',
    '      count=$(cat "$STATE")',
    '      count=$((count + 1))',
    '      printf \'%s\' "$count" > "$STATE"',
    '      if [ "$ASSISTANT_RESULT" = success ] && [ "$count" = 1 ]; then',
    '        printf \'{"Invocation":{"InvocationResults":{"InvocationResult":[]}}}\'',
    '        return',
    '      elif [ "$ASSISTANT_RESULT" = success ]; then',
    '        status=Success; exit_code=0; error_code=; error_info=',
    '      else',
    '        status=Failed; exit_code=7; error_code=ExecutionError; error_info=failed,',
    '      fi',
    '      printf \'{"Invocation":{"InvocationResults":{"InvocationResult":[{"InvocationStatus":"%s","ExitCode":%s,"ErrorCode":"%s","ErrorInfo":"%s"}]}}}\' "$status" "$exit_code" "$error_code" "$error_info"',
    '      ;;',
    '  esac',
    '}',
    'jq() {',
    '  filter="$2"; input=$(cat)',
    '  case "$filter" in',
    '    .InvokeId) printf invoke-test ;;',
    '    *InvocationStatus*)',
    '      if [[ "$input" == *\'"InvocationResult":[]\'* ]]; then printf Pending;',
    '      elif [ "$ASSISTANT_RESULT" = success ]; then printf Success;',
    '      else printf Failed; fi',
    '      ;;',
    '    *ExitCode*) if [ "$ASSISTANT_RESULT" = success ]; then printf 0; else printf 7; fi ;;',
    '    *ErrorCode*) if [ "$ASSISTANT_RESULT" = failure ]; then printf ExecutionError; fi ;;',
    '    *ErrorInfo*) if [ "$ASSISTANT_RESULT" = failure ]; then printf failed; fi ;;',
    '  esac',
    '}',
    'sleep() { :; }',
    cloudAssistantSource,
    'COMMAND=$(mktemp)',
    'printf true > "$COMMAND"',
    'platform_cloud_run i-first123 "$COMMAND"',
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ASSISTANT_RESULT: result,
      PLATFORM_ALIYUN_REGION: 'cn-hangzhou',
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
    },
  })
}

function runRecoveryHarness(
  phase: 'rollbackable' | 'commit-pending' | 'committed',
  failure: 'none' | 'second-rollback' | 'state-write' | 'target-mismatch' = 'none',
) {
  const harness = [
    'set -u',
    'LOG=$(mktemp)',
    'RECOVERY_COMMAND=$(mktemp)',
    'export RECOVERY_COMMAND',
    'trap \'cat "$LOG"\' EXIT',
    'aliyun() {',
    '  if [ "$1 $2" = "oss cat" ]; then',
    '    printf \'{"version":1,"phase":"%s","objectRoot":"deploy-artifacts/platform/123-1","instanceIds":["i-first123","i-second456"]}\\n\' "$RECOVERY_PHASE"',
    '    printf \'%1000000s\' \'\'',
    '  elif [ "$1 $2" = "oss cp" ]; then',
    '    printf \'STATE:committed\\n\' >> "$LOG"',
    '    [ "$RECOVERY_FAILURE" != state-write ]',
    '  elif [ "$1 $2" = "oss rm" ]; then',
    '    printf \'DELETE:%s\\n\' "$3" >> "$LOG"',
    '  fi',
    '}',
    'jq() {',
    '  case "$1" in',
    '    -er)',
    '      case "$2" in',
    '        *".phase"*) printf \'%s\\n\' "$RECOVERY_PHASE" ;;',
    '        *".objectRoot"*) printf \'deploy-artifacts/platform/123-1\\n\' ;;',
    '        *".instanceIds"*) printf \'i-first123\\ni-second456\\n\' ;;',
    '        *) return 2 ;;',
    '      esac',
    '      ;;',
    '    -R)',
    '      while IFS= read -r line; do printf \'"%s"\\n\' "$line"; done',
    '      printf \'%1000000s\' \'\'',
    '      ;;',
    '    -s) printf \'["i-first123","i-second456"]\\n\' ;;',
    '    -nc)',
    '      if [ "$2" = --args ]; then',
    '        printf \'["i-first123","i-second456"]\\n\'',
    '      else',
    '        printf \'{"version":1,"phase":"committed"}\\n\'',
    '      fi',
    '      ;;',
    '    *) return 2 ;;',
    '  esac',
    '}',
    'tail() { printf \'true\\n\'; }',
    'platform_cloud_run() {',
    '  action=$(sed -n \'1s/set -- //p\' "$2")',
    '  printf \'RUN:%s:%s:%s\\n\' "$action" "$1" "$3" >> "$LOG"',
    '  if [ "$RECOVERY_FAILURE" = second-rollback ] && [ "$action:$1" = rollback:i-second456 ]; then',
    '    return 1',
    '  fi',
    '}',
    'source "$RECOVERY_SCRIPT"',
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      RECOVERY_SCRIPT: bashPath(recoveryScript),
      RECOVERY_PHASE: phase,
      RECOVERY_FAILURE: failure,
      PLATFORM_ALIYUN_REGION: 'cn-hangzhou',
      PLATFORM_ECS_INSTANCE_IDS: failure === 'target-mismatch'
        ? 'i-newfirst,i-newsecond'
        : 'i-first123,i-second456',
      PLATFORM_OSS_BUCKET: 'bucket',
      PLATFORM_DEPLOY_OSS_UPLOAD_ENDPOINT: 'oss-cn-hangzhou.aliyuncs.com',
      PLATFORM_DEPLOY_OSS_OBJECT_PREFIX: 'deploy-artifacts/platform',
    },
  })
}

function runCommittedCleanupHarness(dockerState: 'absent' | 'rollback-remains' | 'ps-fails') {
  const runnableHostDeploy = hostDeploySource
    .replace('candidate_env=/run/dsh-platform-candidate.env', 'candidate_env="$CANDIDATE_ENV"')
    .replace('exec 9>/run/dsh-platform-deploy.lock', 'exec 9>"$HOST_LOCK"')
  const harness = [
    'set -- complete-commit',
    'HOST_LOCK=$(mktemp)',
    'CANDIDATE_ENV=$(mktemp -u)',
    'export HOST_LOCK CANDIDATE_ENV',
    'flock() { :; }',
    'docker() {',
    '  case "$1" in',
    '    info) return 0 ;;',
    '    rm) return 0 ;;',
    '    ps)',
    '      [ "$DOCKER_STATE" = ps-fails ] && return 1',
    '      [ "$DOCKER_STATE" = rollback-remains ] && printf \'dsh-platform-rollback\\n\'',
    '      return 0',
    '      ;;',
    '  esac',
    '}',
    runnableHostDeploy,
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DOCKER_STATE: dockerState },
  })
}

function runRollbackProbeHarness(psFailure: 'none' | 'first' | 'second') {
  const runnableHostDeploy = hostDeploySource
    .replace('candidate_env=/run/dsh-platform-candidate.env', 'candidate_env="$CANDIDATE_ENV"')
    .replace('exec 9>/run/dsh-platform-deploy.lock', 'exec 9>"$HOST_LOCK"')
  const harness = [
    'set -- rollback',
    'HOST_LOCK=$(mktemp)',
    'CANDIDATE_ENV=$(mktemp -u)',
    'PS_COUNT=$(mktemp)',
    'printf 0 > "$PS_COUNT"',
    'export HOST_LOCK CANDIDATE_ENV',
    'flock() { :; }',
    'curl() { printf \'{"ok":true}\\n\'; }',
    'sleep() { :; }',
    'docker() {',
    '  case "$1" in',
    '    info) return 0 ;;',
    '    ps)',
    '      count=$(cat "$PS_COUNT")',
    '      count=$((count + 1))',
    '      printf \'%s\' "$count" > "$PS_COUNT"',
    '      [ "$PS_FAILURE:$count" = first:1 ] && return 1',
    '      [ "$PS_FAILURE:$count" = second:2 ] && return 1',
    '      return 0',
    '      ;;',
    '    rm) return 0 ;;',
    '  esac',
    '}',
    runnableHostDeploy,
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PS_FAILURE: psFailure },
  })
}

function runCollectorPrepareHarness(
  pullResult: 'success' | 'failure',
  cacheResult: 'present' | 'missing',
) {
  const runnableHostDeploy = hostDeploySource
    .replace('candidate_env=/run/dsh-platform-candidate.env', 'candidate_env="$CANDIDATE_ENV"')
    .replace('exec 9>/run/dsh-platform-deploy.lock', 'exec 9>"$HOST_LOCK"')
    .replace('workdir=$(mktemp -d /run/dsh-platform-prepare.XXXXXX)', 'workdir=$(mktemp -d)')
  const harness = [
    'LOG=$(mktemp)',
    'HOST_LOCK=$(mktemp)',
    'CANDIDATE_ENV=$(mktemp -u)',
    'export LOG HOST_LOCK CANDIDATE_ENV',
    'flock() { :; }',
    'dnf() { :; }',
    'yum() { :; }',
    'systemctl() { :; }',
    'sleep() { :; }',
    'sha256sum() { cat >/dev/null; }',
    'gzip() { :; }',
    'openssl() { :; }',
    'curl() {',
    '  args="$*"',
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = -o ]; then : > "$2"; return 0; fi',
    '    shift',
    '  done',
    '  case "$args" in',
    '    *latest/api/token*) printf token ;;',
    '    *owner-account-id*) printf 1279431675399365 ;;',
    '    */readyz*) printf \'{"ok":true,"attachmentStorage":"postgres"}\' ;;',
    '  esac',
    '}',
    'docker() {',
    '  printf \'%s\\n\' "$*" >> "$LOG"',
    '  case "$1:${2:-}" in',
    '    pull:*) [ "$PULL_RESULT" = success ] ;;',
    '    image:inspect) [ "$CACHE_RESULT" = present ] ;;',
    '    *) return 0 ;;',
    '  esac',
    '}',
    'set +e',
    '(',
    '  set -- prepare',
    runnableHostDeploy,
    ')',
    'status=$?',
    'cat "$LOG"',
    'rm -f "$LOG" "$HOST_LOCK" "$CANDIDATE_ENV"',
    'exit "$status"',
  ].join('\n')
  return spawnSync('bash', ['-c', harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      PULL_RESULT: pullResult,
      CACHE_RESULT: cacheResult,
      DSH_DEPLOY_IMAGE_URL: 'https://image.fixture',
      DSH_DEPLOY_IMAGE_SHA256: 'image-sha',
      DSH_DEPLOY_ENV_URL: 'https://environment.fixture',
      DSH_DEPLOY_ENV_SHA256: 'environment-sha',
      DSH_DEPLOY_ENV_KEY: 'environment-key',
      DSH_DEPLOY_IMAGE: 'platform-image:fixture',
      DSH_DEPLOY_STORAGE: 'postgres',
      DSH_RELAY_INSTANCE_ID: 'relay-1',
    },
  })
}

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(repoRoot, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function job(workflow: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[name])) {
    throw new TypeError(`workflow must define the ${name} job`)
  }
  return workflow.jobs[name]
}

function steps(jobValue: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(jobValue.steps)) throw new TypeError('job must define steps')
  return jobValue.steps.filter(isRecord)
}

describe('assertOperatedPlatformEnvironment', () => {
  it('treats unset and empty as production and refuses every other selection', () => {
    expect(assertOperatedPlatformEnvironment(undefined)).toBe('production')
    expect(assertOperatedPlatformEnvironment('')).toBe('production')
    expect(assertOperatedPlatformEnvironment('production')).toBe('production')
    expect(() => assertOperatedPlatformEnvironment('development')).toThrow(/only production/)
    expect(() => assertOperatedPlatformEnvironment('staging')).toThrow(/only production/)
    expect(() => assertOperatedPlatformEnvironment('Production')).toThrow(/only production/)
  })
})

describe('production and deploy names', () => {
  it('lists listen-process names before the ECS apply names', () => {
    expect(PLATFORM_DEPLOY_REQUIRED_ENV.slice(0, PLATFORM_PRODUCTION_REQUIRED_ENV.length))
      .toEqual([...PLATFORM_PRODUCTION_REQUIRED_ENV])
    expect(PLATFORM_DEPLOY_REQUIRED_ENV.slice(PLATFORM_PRODUCTION_REQUIRED_ENV.length))
      .toEqual([
        'PLATFORM_ALIYUN_REGION',
        'PLATFORM_ALIYUN_OIDC_PROVIDER_ARN',
        'PLATFORM_ALIYUN_DEPLOY_ROLE_ARN',
        'PLATFORM_ECS_INSTANCE_IDS',
        'PLATFORM_ALB_SERVER_GROUP_ID',
        'PLATFORM_DEPLOY_OSS_UPLOAD_ENDPOINT',
        'PLATFORM_DEPLOY_OSS_OBJECT_PREFIX',
      ])
  })

  it('parses the complete operated identity and verified durable-store configuration before traffic', () => {
    expect(loadOperatedPlatformConfig(completeDeployEnv())).toMatchObject({
      environment: {
        environment: 'production',
        origin: 'https://platform.example.test',
        credentialReference: 'credentials://github-oauth/production',
        databaseIdentity: 'gestalt',
        identityNamespace: 'gestalt-production',
      },
      postgres: { host: 'postgres.example.test', user: 'gestalt', database: 'gestalt', ssl: { ca: APSARADB_CA, rejectUnauthorized: true } },
      redis: { host: 'redis.example.test', username: 'gestalt', tls: true, ca: APSARADB_CA },
      relayRedisKeyPrefix: 'gestalt:relay',
      remoteAttachments: {
        storage: 'oss',
        maxBlobBytes: 104857600,
        capabilityLifetimeMs: 900000,
        maxRetainedBlobs: 10000,
        sweepIntervalMs: 60000,
        cleanupConcurrency: 8,
      },
      oss: {
        endpoint: 'oss-cn-hangzhou-internal.aliyuncs.com',
        bucket: 'gestalt-secret',
        auth: 'ecs-ram-role/gestalt-vpc',
        objectPrefix: 'remote-attachments/production',
        timeoutMs: 10000,
      },
    })
    expect(loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'postgres',
    }).remoteAttachments.storage).toBe('postgres')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'mixed',
    })).toThrow('PLATFORM_REMOTE_ATTACHMENT_STORAGE')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_ORIGIN: 'https://localhost' }))
      .toThrow('must not use a local host')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_POSTGRES_SSL: 'disable' }))
      .toThrow('PLATFORM_POSTGRES_SSL')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_APSARADB_CA_BASE64: 'not-base64' }))
      .toThrow('PLATFORM_APSARADB_CA_BASE64')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_REDIS_TLS: '0' }))
      .toThrow('PLATFORM_REDIS_TLS')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_POSTGRES_PORT: 'invalid' }))
      .toThrow('PLATFORM_POSTGRES_PORT')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES: '104857601',
    })).toThrow('PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_OSS_ENDPOINT: 'example.com',
    })).toThrow('PLATFORM_OSS_ENDPOINT')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_OSS_BUCKET: 'Bad_Bucket',
    })).toThrow('PLATFORM_OSS_BUCKET')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_OSS_AUTH: 'access-key/plaintext',
    })).toThrow('PLATFORM_OSS_AUTH')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_OSS_OBJECT_PREFIX: 'remote-attachments//production',
    })).toThrow('PLATFORM_OSS_OBJECT_PREFIX')
    expect(() => loadOperatedPlatformConfig({
      ...completeDeployEnv(), PLATFORM_OSS_TIMEOUT_MS: '60001',
    })).toThrow('PLATFORM_OSS_TIMEOUT_MS')
  })

  it('reports missing names in declaration order and reads present values', () => {
    expect(missingPlatformProductionEnv({})).toEqual([...PLATFORM_PRODUCTION_REQUIRED_ENV])
    expect(missingPlatformDeployEnv({
      PLATFORM_ORIGIN: 'https://platform.example.test',
      PLATFORM_REDIS_HOST: 'redis.example.test',
    })).toEqual([
      'PLATFORM_GITHUB_CLIENT_ID',
      'PLATFORM_GITHUB_CLIENT_SECRET',
      'PLATFORM_GITHUB_CALLBACK',
      'PLATFORM_GITHUB_CREDENTIAL_REFERENCE',
      'PLATFORM_POSTGRES_HOST',
      'PLATFORM_POSTGRES_USER',
      'PLATFORM_POSTGRES_PASSWORD',
      'PLATFORM_APSARADB_CA_BASE64',
      'PLATFORM_POSTGRES_DATABASE',
      'PLATFORM_IDENTITY_NAMESPACE',
      'PLATFORM_REDIS_USER',
      'PLATFORM_REDIS_PASSWORD',
      'PLATFORM_OSS_ENDPOINT',
      'PLATFORM_OSS_BUCKET',
      'PLATFORM_OSS_AUTH',
      'PLATFORM_OSS_OBJECT_PREFIX',
      'PLATFORM_OSS_TIMEOUT_MS',
      'PLATFORM_RELAY_REDIS_KEY_PREFIX',
      'PLATFORM_RELAY_INSTANCE_ID',
      'PLATFORM_RELAY_CAPACITY_RETRY_AFTER_MS',
      'PLATFORM_RELAY_DELIVERY_ACK_TIMEOUT_MS',
      'PLATFORM_RELAY_DIRECTORY_TTL_MS',
      'PLATFORM_RELAY_HEARTBEAT_TIMEOUT_MS',
      'PLATFORM_RELAY_MAX_BUFFERED_CIPHERTEXT_BYTES',
      'PLATFORM_RELAY_MAX_CONNECTIONS',
      'PLATFORM_RELAY_MAX_PENDING_DELIVERIES',
      'PLATFORM_RELAY_MAX_PENDING_CHALLENGES',
      'PLATFORM_RELAY_ATTACH_TIMEOUT_MS',
      'PLATFORM_REMOTE_ATTACHMENT_MAX_BLOB_BYTES',
      'PLATFORM_REMOTE_ATTACHMENT_CAPABILITY_LIFETIME_MS',
      'PLATFORM_REMOTE_ATTACHMENT_MAX_RETAINED_BLOBS',
      'PLATFORM_REMOTE_ATTACHMENT_STORAGE',
      'PLATFORM_REMOTE_ATTACHMENT_SWEEP_INTERVAL_MS',
      'PLATFORM_REMOTE_ATTACHMENT_CLEANUP_CONCURRENCY',
      'PLATFORM_TOKEN_SIGNING_KEY',
      'PLATFORM_POLLING_SIGNING_KEY',
      'PLATFORM_ALIYUN_REGION',
      'PLATFORM_ALIYUN_OIDC_PROVIDER_ARN',
      'PLATFORM_ALIYUN_DEPLOY_ROLE_ARN',
      'PLATFORM_ECS_INSTANCE_IDS',
      'PLATFORM_ALB_SERVER_GROUP_ID',
      'PLATFORM_DEPLOY_OSS_UPLOAD_ENDPOINT',
      'PLATFORM_DEPLOY_OSS_OBJECT_PREFIX',
    ])
    expect(requiredPlatformEnv('PLATFORM_ORIGIN', completeDeployEnv())).toBe('https://platform.example.test')
    expect(() => requiredPlatformEnv('PLATFORM_ORIGIN', {})).toThrow('PLATFORM_ORIGIN')
    expect(readPlatformSigningKey('PLATFORM_TOKEN_SIGNING_KEY', completeDeployEnv())).toEqual(
      Uint8Array.from(Buffer.from(HEX, 'hex')),
    )
    expect(validatePlatformEcsInstanceIds(completeDeployEnv())).toEqual(['i-first123', 'i-second456'])
    for (const instanceIds of ['i-first123', 'i-first123,', 'i-first123,i-first123', 'a,b', 'i-a,i-b,i-c']) {
      expect(() => validatePlatformEcsInstanceIds({
        ...completeDeployEnv(), PLATFORM_ECS_INSTANCE_IDS: instanceIds,
      })).toThrow('exactly two distinct ECS instance ids')
    }
    expect(() => readPlatformSigningKey('PLATFORM_TOKEN_SIGNING_KEY', {
      ...completeDeployEnv(),
      PLATFORM_TOKEN_SIGNING_KEY: 'zz',
    })).toThrow(/32 bytes of hex/)
  })

  it('rejects decoded ApsaraDB authorities that are not a clean CA-only PEM chain', () => {
    const invalidAuthorities = [
      'plain text instead of PEM',
      `${APSARADB_CA}\ntrailing content`,
      APSARADB_CA.replace('MIID', '!!!!'),
      LEAF_CERTIFICATE,
    ]
    for (const authority of invalidAuthorities) {
      expect(() => loadOperatedPlatformConfig({
        ...completeDeployEnv(),
        PLATFORM_APSARADB_CA_BASE64: Buffer.from(authority).toString('base64'),
      })).toThrow('PLATFORM_APSARADB_CA_BASE64')
    }
  })
})

describe('runPlatformProductionEnvCli', () => {
  it('prints missing names without values and accepts a complete production set', () => {
    const stderr: string[] = []
    const write = console.error
    console.error = (line: unknown) => {
      stderr.push(String(line))
    }
    try {
      expect(runPlatformProductionEnvCli({
        ...completeDeployEnv(),
        PLATFORM_GITHUB_CLIENT_SECRET: DISTINCTIVE_SECRET,
        PLATFORM_ALIYUN_DEPLOY_ROLE_ARN: '',
      })).toBe(1)
      expect(runPlatformProductionEnvCli({
        ...completeDeployEnv(),
        PLATFORM_ENVIRONMENT: 'development',
      })).toBe(1)
      expect(runPlatformProductionEnvCli(completeDeployEnv())).toBe(0)
    } finally {
      console.error = write
    }
    expect(stderr.join('\n')).toContain('PLATFORM_ALIYUN_DEPLOY_ROLE_ARN')
    expect(stderr.join('\n')).toContain('only production')
    expect(stderr.join('\n')).not.toContain(DISTINCTIVE_SECRET)
  })

  it('exits nonzero from the source entry without printing secret values', () => {
    const missing = spawnCli({})
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('PLATFORM_ORIGIN')
    expect(missing.stderr).toContain('PLATFORM_ECS_INSTANCE_IDS')
    const refused = spawnCli({
      ...completeDeployEnv(),
      PLATFORM_ENVIRONMENT: 'development',
    })
    expect(refused.status).toBe(1)
    expect(`${refused.stdout}${refused.stderr}`).not.toContain(DISTINCTIVE_SECRET)
    const ok = spawnCli(completeDeployEnv())
    expect(ok.status).toBe(0)
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(DISTINCTIVE_SECRET)
  })
})

describe('operated Platform composition', () => {
  it('loads one operated identity and mounts endpoint-owned pairing over durable stores', () => {
    expect(bootSource).toContain('launchOperatedPlatform()')
    expect(launchSource).toContain('loadOperatedPlatformConfig')
    expect(remoteAccessResourcesSource).toContain('PostgresPersonalPairingAuthorityStore')
    expect(remoteAccessResourcesSource).toContain('PostgresRelayRouteStore')
    expect(remoteAccessResourcesSource).toContain('RedisRelayCoordinator')
    expect(launchSource).toContain('OperatedRemoteAccessResources')
    const productComposition = bootSource + launchSource
    expect(productComposition).not.toContain('loadPlatformEnvironment')
    expect(productComposition).not.toContain('dev.gestaltrun.invalid')
    expect(productComposition).not.toContain('rejectUnauthorized: false')
    expect(productComposition).not.toContain('PLATFORM_REDIS_TLS')
    expect(productComposition).toContain('PersonalPairingProvider')
    expect(productComposition).not.toContain('DevelopmentKeylessPairingHandshakeProvider')
    expect(productComposition).not.toContain('MemoryPersonalPairingAuthorityStore')
    expect(productComposition).toContain('RemoteRelayProvider')
    expect(productComposition).toContain('OssRemoteAttachmentStore')
    expect(productComposition).toContain('createEcsRamRoleOssClient')
    expect(dockerfileSource).toContain('ali-oss@6.23.0')
    expect(productComposition).toContain('PostgresRemoteAttachmentStore')
    expect(productComposition).not.toContain('production-env-cli')
    expect(readFileSync(new URL('../src/production-env.ts', import.meta.url), 'utf8')).not.toContain('process.exit')
  })
})

describe('Platform release workflows', () => {
  it('converts a native Windows path for Git Bash recovery harnesses', () => {
    expect(bashPath(String.raw`D:\a\deepseek-harness\platform-recover.sh`, 'win32'))
      .toBe('/d/a/deepseek-harness/platform-recover.sh')
    expect(bashPath('/tmp/platform-recover.sh', 'darwin')).toBe('/tmp/platform-recover.sh')
  })

  it('validates Environment production without applying ECS unless deploy is set', () => {
    const workflow = loadWorkflow('.github/workflows/platform-deploy.yml')
    expect(workflow.on).toMatchObject({
      workflow_dispatch: {
        inputs: {
          deploy: { type: 'boolean', default: false },
          recover: { type: 'boolean', default: false },
          attachment_storage: { type: 'choice', default: 'postgres' },
        },
      },
    })
    const validate = job(workflow, 'validate')
    const deploy = job(workflow, 'deploy')
    const recover = job(workflow, 'recover')
    expect(validate.environment).toBe('production')
    expect(deploy.environment).toBe('production')
    expect(deploy.needs).toBe('validate')
    expect(deploy.if).toBe('${{ inputs.deploy && !inputs.recover }}')
    expect(recover.if).toBe('${{ inputs.recover }}')
    expect(validate.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    expect(deploy.permissions).toEqual({ contents: 'read', packages: 'read', 'id-token': 'write' })
    expect(JSON.stringify(deploy)).toContain('"role-session-expiration":21600')
    const validateSteps = steps(validate)
    expect(steps(deploy)[0]).toMatchObject({
      uses: 'actions/checkout@v6',
      with: { 'persist-credentials': false },
    })
    const validateStep = validateSteps.find(step => typeof step.run === 'string'
      && step.run.includes('apps/platform/src/production-env-cli.ts'))
    if (validateStep === undefined) throw new TypeError('validate job must run production-env.ts')
    const validateIndex = validateSteps.indexOf(validateStep)
    const pnpmSetupIndex = validateSteps.findIndex(step => step.uses === 'pnpm/action-setup@v4')
    const installIndex = validateSteps.findIndex(step => step.run
      === 'pnpm install --frozen-lockfile --ignore-scripts')
    expect(pnpmSetupIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(pnpmSetupIndex).toBeLessThan(validateIndex)
    expect(installIndex).toBeLessThan(validateIndex)
    expect(String(validateStep.run)).toContain('--import tsx/esm')
    if (!isRecord(validateStep.env)) throw new TypeError('validate step must define env')
    for (const name of PLATFORM_DEPLOY_REQUIRED_ENV) {
      expect(validateStep.env, name).toHaveProperty(name)
    }
    const oidcSteps = [...steps(validate), ...steps(deploy)].filter(step => typeof step.uses === 'string'
      && step.uses.startsWith('aliyun/configure-aliyun-credentials-action@'))
    expect(oidcSteps).toHaveLength(2)
    expect(oidcSteps.every(step => step.uses
      === 'aliyun/configure-aliyun-credentials-action@1e5248c8d5d93a8781ac344a68e19a43341e79e6')).toBe(true)
    const deployNode = steps(deploy).find(step => step.uses === 'actions/setup-node@v6')
    expect(deployNode?.with).toEqual({ 'node-version': 24 })
    expect(steps(recover).some(step => step.uses === 'actions/setup-node@v6')).toBe(false)
    const prepare = steps(deploy).find(step => typeof step.run === 'string'
      && step.run.includes('docker create'))
    const apply = steps(deploy).find(step => typeof step.run === 'string'
      && step.run.includes('platform_cloud_run'))
    if (prepare === undefined || apply === undefined) {
      throw new TypeError('deploy job must prepare encrypted artifacts and invoke Cloud Assistant')
    }
    const prepareSource = String(prepare.run)
    const applySource = String(apply.run)
    expect(applySource).toContain('set -eEuo pipefail')
    expect(applySource).toContain('source apps/platform/scripts/platform-cloud-assistant.sh')
    expect(applySource).toContain('source apps/platform/scripts/platform-public-readiness.sh')
    expect(applySource).toContain('aliyun oss cp')
    expect(applySource).toContain('aliyun oss sign')
    for (const source of [applySource, recoverySource]) {
      const ossCommands = shellLogicalLines(source).filter(line => line.includes('aliyun oss '))
      expect(ossCommands.length).toBeGreaterThan(0)
      for (const command of ossCommands) {
        expect(command).toContain('--region "$PLATFORM_ALIYUN_REGION"')
      }
    }
    expect(applySource).toContain('| head -1')
    expect(applySource).toContain('SCRIPT_SHA256')
    expect(applySource).toContain('rollback_platform')
    expect(applySource).toContain('rolling replacement keeps the other private ECS instance serving')
    expect(publicReadinessSource).toContain('public readiness through the production HTTPS origin')
    expect(publicReadinessSource).toContain('${PLATFORM_ORIGIN}/readyz')
    expect(publicReadinessSource).toContain('AbortSignal.timeout(5_000)')
    expect(publicReadinessSource).toContain("redirect: 'error'")
    expect(publicReadinessSource).not.toContain('curl ')
    expect(publicReadinessSource).toContain('expected_instances+=("relay-${expected_index}")')
    expect(applySource.indexOf('platform_public_readiness 30'))
      .toBeLessThan(applySource.indexOf('rollback_cleanup_failed=0'))
    expect(applySource).toContain('rollback_cleanup_failed=0')
    expect(applySource.indexOf('rollback_cleanup_failed=0'))
      .toBeLessThan(applySource.indexOf(' cutover'))
    expect(prepareSource).toContain('openssl enc -aes-256-cbc -pbkdf2')
    expect(prepareSource).toContain("grep '^PLATFORM_'")
    expect(prepareSource).toContain('-e PLATFORM_APSARADB_CA_BASE64')
    expect(hostDeploySource).toContain('--log-opt max-size=20m')
    expect(hostDeploySource).toContain('--log-opt max-file=3')
    expect(hostDeploySource).toContain('dist/oss-lifecycle-cli.mjs')
    expect(hostDeploySource).toContain('dsh-platform-candidate')
    expect(hostDeploySource).toContain('wait_for_storage 18080')
    expect(hostDeploySource).toContain('docker inspect dsh-platform-rollback')
    expect(hostDeploySource).toContain('docker stop --time 60 dsh-platform')
    expect(hostDeploySource).toContain('attachment-storage-cutover-cli.mjs')
    expect(hostDeploySource).toContain('attachmentStorage\":\"(postgres|oss)')
    expect(hostDeploySource).toContain('100.100.100.200')
    expect(hostDeploySource).toContain('X-aliyun-ecs-metadata-token')
    expect(hostDeploySource).toContain('loongcollector:v3.0.12.0-25723a1-aliyun')
    expect(cloudAssistantSource).toContain('aliyun ecs RunCommand --region "$PLATFORM_ALIYUN_REGION"')
    expect(cloudAssistantSource).toContain('aliyun ecs DescribeInvocationResults --region "$PLATFORM_ALIYUN_REGION"')
    expect(cloudAssistantSource).toContain('InvocationStatus')
    expect(applySource).toContain("trap 'on_deploy_interrupt 130' INT")
    expect(applySource).toContain('finalize_failed=0')
    expect(hostDeploySource).toContain('flock -x 9')
    const targetCheck = steps(validate).find(step => typeof step.run === 'string'
      && step.run.includes('ListServerGroupServers'))
    expect(String(targetCheck?.run)).toContain('.TotalCount == 2 and (.Servers | length) == 2')
    expect(String(targetCheck?.run)).toContain('.Status == "Available" and .Port == 80')
    const recoverWorkflowSource = String(steps(recover).find(step => typeof step.run === 'string'
      && step.run.includes('platform-recover.sh'))?.run)
    expect(recoverWorkflowSource.trim()).toBe('bash apps/platform/scripts/platform-recover.sh')
    expect(recoverySource).toContain('active-state.json')
    expect(recoverySource).toContain('run_recovery_on_all rollback 2100')
    expect(recoverySource).toContain('run_recovery_on_all complete-rollback-cleanup 2100')
    expect(recoverySource).toContain('write_recovery_command cutover')
    expect(recoverySource).toContain('run_recovery_on_all complete-commit 2100')
    expect(hostDeploySource).toContain('complete-commit)')
    expect(hostDeploySource).toContain('complete-rollback-cleanup)')
    expect(hostDeploySource).toContain("docker ps -a --format '{{.Names}}'")
    expect(hostDeploySource).toContain('test ! -e "$candidate_env"')
    expect(hostDeploySource).toContain('DSH_DEPLOY_IMAGE:-$(docker inspect dsh-platform')
    expect(applySource).toContain('write_deploy_state rollbackable')
    expect(applySource).toContain('write_deploy_state commit-pending')
    expect(applySource).toContain('write_deploy_state committed')
    expect(applySource).toContain("grep -Fq 'StatusCode=404'")
    expect(applySource).toContain('failed to determine whether an unresolved deployment exists')
    expect(String(targetCheck?.run)).toContain('aliyun ecs DescribeCloudAssistantStatus --region "$PLATFORM_ALIYUN_REGION"')
    expect(String(targetCheck?.run)).toContain('aliyun alb ListServerGroupServers --region "$PLATFORM_ALIYUN_REGION"')
    expect(hostDeploySource.indexOf('wait_for_ready 80 || rollback_failed=1'))
      .toBeLessThan(hostDeploySource.indexOf('exit "$rollback_failed"'))
    expect(applySource.indexOf('platform_public_readiness 30'))
      .toBeLessThan(applySource.indexOf('write_deploy_state commit-pending'))
    expect(applySource.indexOf('write_deploy_state commit-pending'))
      .toBeLessThan(applySource.indexOf('rollback_cleanup_failed=0'))
    expect(JSON.stringify(workflow)).not.toContain('PLATFORM_ECS_SSH_KEY')
    expect(JSON.stringify(workflow)).not.toContain('PLATFORM_ECS_HOSTS')
    expect(JSON.stringify(workflow)).not.toContain('ssh -i')
    if (!isRecord(workflow.jobs)) throw new TypeError('deploy workflow must define jobs')
    for (const [name, value] of Object.entries(workflow.jobs)) {
      if (!isRecord(value)) throw new TypeError(`${name} must be a job`)
      expect(value.environment, name).toBe('production')
    }
  })

  it('replaces the collector only after the fixed image is pulled or found in cache', { timeout: 60_000 }, () => {
    const pulled = runCollectorPrepareHarness('success', 'missing')
    expect(pulled.status).toBe(0)
    expect(pulled.stdout).toMatch(/pull .*loongcollector/)
    expect(pulled.stdout).not.toContain('image inspect')
    expect(pulled.stdout.indexOf('pull ')).toBeLessThan(pulled.stdout.indexOf('rm -f dsh-loongcollector'))
    expect(pulled.stdout.indexOf('rm -f dsh-loongcollector'))
      .toBeLessThan(pulled.stdout.indexOf('run -d --name dsh-loongcollector'))

    const cached = runCollectorPrepareHarness('failure', 'present')
    expect(cached.status).toBe(0)
    expect(cached.stdout.indexOf('pull ')).toBeLessThan(cached.stdout.indexOf('image inspect'))
    expect(cached.stdout.indexOf('image inspect'))
      .toBeLessThan(cached.stdout.indexOf('rm -f dsh-loongcollector'))
    expect(cached.stdout.indexOf('rm -f dsh-loongcollector'))
      .toBeLessThan(cached.stdout.indexOf('run -d --name dsh-loongcollector'))

    const unavailable = runCollectorPrepareHarness('failure', 'missing')
    expect(unavailable.status).toBe(1)
    expect(unavailable.stdout).toContain('image inspect')
    expect(unavailable.stdout).not.toContain('rm -f dsh-loongcollector')
    expect(unavailable.stdout).not.toContain('run -d --name dsh-loongcollector')
  })

  it.each(['unreachable', 'redirect', 'wrong-storage', 'one-backend'] as const)(
    'refuses cleanup when public readiness is %s',
    (result) => {
      const failed = runPublicReadinessHarness(result)
      expect(failed.status).toBe(1)
      expect(failed.stdout).toContain('public readiness through the production HTTPS origin')
      expect(failed.stdout).not.toContain('CLEANUP')
    },
  )

  it('reaches cleanup without rollback only after public readiness succeeds', () => {
    const succeeded = runPublicReadinessHarness('success')
    expect(succeeded.status).toBe(0)
    expect(succeeded.stdout).toContain('public readiness through the production HTTPS origin')
    expect(succeeded.stdout).toContain('CLEANUP')
  })

  it('executes the Node readiness request and rejects HTTP errors, redirects, timeouts, and connection failure', {
    timeout: 15_000,
  }, async () => {
    const server = createServer((request, response) => {
      if (request.url === '/ok') {
        response.end('{"ok":true}')
      } else if (request.url === '/redirect') {
        response.writeHead(302, { location: '/ok' }).end()
      } else if (request.url === '/error') {
        response.writeHead(500).end('unavailable')
      }
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`
    try {
      await expect(runPublicHttpsGet(`${origin}/ok`)).resolves.toEqual({
        status: 0,
        stderr: '',
        stdout: '{"ok":true}',
      })
      for (const path of ['/error', '/redirect', '/slow']) {
        const result = await runPublicHttpsGet(`${origin}${path}`)
        expect(result.status, path).toBe(1)
        expect(result.stderr, path).toContain('platform: public readiness request failed:')
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolvePromise) => {
        server.close(() => { resolvePromise() })
      })
    }
    const unavailable = await runPublicHttpsGet(origin)
    expect(unavailable.status).toBe(1)
    expect(unavailable.stderr).toContain('platform: public readiness request failed:')
  })

  it('waits for Cloud Assistant terminal success and rejects a nonzero execution', () => {
    expect(runCloudAssistantHarness('success').status).toBe(0)
    const failed = runCloudAssistantHarness('failure')
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('status=Failed exit=7 code=ExecutionError info=failed')
  })

  it('executes each durable recovery phase in authority order', () => {
    const rollbackable = runRecoveryHarness('rollbackable')
    expect(rollbackable.status).toBe(0)
    expect(rollbackable.stdout).toContain('RUN:rollback:i-first123:2100')
    expect(rollbackable.stdout).toContain('RUN:rollback:i-second456:2100')
    expect(rollbackable.stdout).not.toContain('RUN:cutover')
    expect(rollbackable.stdout).toContain('DELETE:oss://bucket/deploy-artifacts/platform/active-state.json')

    const pending = runRecoveryHarness('commit-pending')
    expect(pending.status).toBe(0)
    const cleanup = pending.stdout.indexOf('RUN:complete-rollback-cleanup:i-second456:2100')
    const cutover = pending.stdout.indexOf('RUN:cutover:i-first123:300')
    const committed = pending.stdout.indexOf('STATE:committed')
    const finalize = pending.stdout.indexOf('RUN:complete-commit:i-first123:2100')
    expect(cleanup).toBeGreaterThanOrEqual(0)
    expect(cleanup).toBeLessThan(cutover)
    expect(cutover).toBeLessThan(committed)
    expect(committed).toBeLessThan(finalize)
    expect(pending.stdout).toContain('DELETE:oss://bucket/deploy-artifacts/platform/active-state.json')

    const committedRun = runRecoveryHarness('committed')
    expect(committedRun.status).toBe(0)
    expect(committedRun.stdout).toContain('RUN:complete-commit:i-first123:2100')
    expect(committedRun.stdout).toContain('RUN:complete-commit:i-second456:2100')
    expect(committedRun.stdout).not.toContain('RUN:cutover')
    expect(committedRun.stdout).not.toContain('STATE:committed')
  })

  it('keeps durable state after partial instance or state-write failure', () => {
    const partial = runRecoveryHarness('rollbackable', 'second-rollback')
    expect(partial.status).toBe(1)
    expect(partial.stdout).toContain('RUN:rollback:i-first123:2100')
    expect(partial.stdout).toContain('RUN:rollback:i-second456:2100')
    expect(partial.stdout).not.toContain('DELETE:oss://bucket/deploy-artifacts/platform/active-state.json')

    const stateWrite = runRecoveryHarness('commit-pending', 'state-write')
    expect(stateWrite.status).toBe(1)
    expect(stateWrite.stdout).toContain('RUN:cutover:i-first123:300')
    expect(stateWrite.stdout).toContain('STATE:committed')
    expect(stateWrite.stdout).not.toContain('RUN:complete-commit')
    expect(stateWrite.stdout).not.toContain('DELETE:oss://bucket/deploy-artifacts/platform/active-state.json')

    const targetMismatch = runRecoveryHarness('rollbackable', 'target-mismatch')
    expect(targetMismatch.status).toBe(1)
    expect(targetMismatch.stderr).toContain('recovery targets differ from the durable state')
    expect(targetMismatch.stdout).not.toContain('RUN:')
    expect(targetMismatch.stdout).not.toContain('DELETE:oss://bucket/deploy-artifacts/platform/active-state.json')
  })

  it('rejects committed recovery while a rollback container remains', () => {
    expect(runCommittedCleanupHarness('absent').status).toBe(0)
    expect(runCommittedCleanupHarness('rollback-remains').status).toBe(1)
    expect(runCommittedCleanupHarness('ps-fails').status).toBe(1)
  })

  it('keeps rollback state when Docker container enumeration fails', () => {
    expect(runRollbackProbeHarness('none').status).toBe(0)
    expect(runRollbackProbeHarness('first').status).toBe(1)
    expect(runRollbackProbeHarness('second').status).toBe(1)
  })

  it('builds the image on master path changes without publishing to GHCR', () => {
    const workflow = loadWorkflow('.github/workflows/platform-image.yml')
    if (!isRecord(workflow.on) || !isRecord(workflow.on.push) || !isRecord(workflow.on.pull_request)) {
      throw new TypeError('image workflow must define push and pull_request')
    }
    expect(workflow.on.push.branches).toEqual(['master'])
    expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths)
    const build = job(workflow, 'build')
    const buildPush = steps(build).find(step => typeof step.uses === 'string'
      && step.uses.startsWith('docker/build-push-action@'))
    if (buildPush === undefined || !isRecord(buildPush.with)) {
      throw new TypeError('image workflow must define docker/build-push-action')
    }
    expect(buildPush.with.push).not.toBe(true)
    expect(String(buildPush.with.push)).toContain('workflow_dispatch')
    expect(String(buildPush.with.push)).toContain('inputs.push')
    const login = steps(build).find(step => typeof step.uses === 'string'
      && step.uses.startsWith('docker/login-action@'))
    if (login === undefined) throw new TypeError('image workflow must define docker/login-action')
    expect(String(login.if)).toContain('workflow_dispatch')
    expect(String(login.if)).toContain('inputs.push')
  })
})
