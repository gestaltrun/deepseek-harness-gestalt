import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
} from '../src/production-env.ts'

const HEX = 'ab'.repeat(32)
const DISTINCTIVE_SECRET = 'super-secret-token-value-do-not-print'
const script = fileURLToPath(new URL('../src/production-env-cli.ts', import.meta.url))
const bootSource = readFileSync(new URL('../src/boot.ts', import.meta.url), 'utf8')
const launchSource = readFileSync(new URL('../src/launch.ts', import.meta.url), 'utf8')
const remoteAccessResourcesSource = readFileSync(new URL('../src/remote-access-resources.ts', import.meta.url), 'utf8')
const repoRoot = resolve(import.meta.dirname, '../../..')

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
    PLATFORM_POSTGRES_DATABASE: 'gestalt',
    PLATFORM_IDENTITY_NAMESPACE: 'gestalt-production',
    PLATFORM_REDIS_HOST: 'redis.example.test',
    PLATFORM_REDIS_USER: 'gestalt',
    PLATFORM_REDIS_PASSWORD: DISTINCTIVE_SECRET,
    PLATFORM_RELAY_REDIS_KEY_PREFIX: 'gestalt:relay',
    PLATFORM_TOKEN_SIGNING_KEY: HEX,
    PLATFORM_POLLING_SIGNING_KEY: HEX,
    PLATFORM_ECS_SSH_KEY: '-----BEGIN DISTINCTIVE KEY-----',
    PLATFORM_ECS_HOSTS: '10.0.0.1,10.0.0.2',
  }
}

function spawnCli(env: NodeJS.Dict<string>) {
  return spawnSync(process.execPath, ['--experimental-strip-types', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
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
      .toEqual(['PLATFORM_ECS_SSH_KEY', 'PLATFORM_ECS_HOSTS'])
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
      postgres: { host: 'postgres.example.test', user: 'gestalt', database: 'gestalt', ssl: { rejectUnauthorized: true } },
      redis: { host: 'redis.example.test', username: 'gestalt', tls: true },
      relayRedisKeyPrefix: 'gestalt:relay',
    })
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_ORIGIN: 'https://localhost' }))
      .toThrow('must not use a local host')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_POSTGRES_SSL: 'disable' }))
      .toThrow('PLATFORM_POSTGRES_SSL')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_REDIS_TLS: '0' }))
      .toThrow('PLATFORM_REDIS_TLS')
    expect(() => loadOperatedPlatformConfig({ ...completeDeployEnv(), PLATFORM_POSTGRES_PORT: 'invalid' }))
      .toThrow('PLATFORM_POSTGRES_PORT')
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
      'PLATFORM_POSTGRES_DATABASE',
      'PLATFORM_IDENTITY_NAMESPACE',
      'PLATFORM_REDIS_USER',
      'PLATFORM_REDIS_PASSWORD',
      'PLATFORM_RELAY_REDIS_KEY_PREFIX',
      'PLATFORM_TOKEN_SIGNING_KEY',
      'PLATFORM_POLLING_SIGNING_KEY',
      'PLATFORM_ECS_SSH_KEY',
      'PLATFORM_ECS_HOSTS',
    ])
    expect(requiredPlatformEnv('PLATFORM_ORIGIN', completeDeployEnv())).toBe('https://platform.example.test')
    expect(() => requiredPlatformEnv('PLATFORM_ORIGIN', {})).toThrow('PLATFORM_ORIGIN')
    expect(readPlatformSigningKey('PLATFORM_TOKEN_SIGNING_KEY', completeDeployEnv())).toEqual(
      Uint8Array.from(Buffer.from(HEX, 'hex')),
    )
    expect(() => readPlatformSigningKey('PLATFORM_TOKEN_SIGNING_KEY', {
      ...completeDeployEnv(),
      PLATFORM_TOKEN_SIGNING_KEY: 'zz',
    })).toThrow(/32 bytes of hex/)
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
        PLATFORM_ECS_SSH_KEY: '',
      })).toBe(1)
      expect(runPlatformProductionEnvCli({
        ...completeDeployEnv(),
        PLATFORM_ENVIRONMENT: 'development',
      })).toBe(1)
      expect(runPlatformProductionEnvCli(completeDeployEnv())).toBe(0)
    } finally {
      console.error = write
    }
    expect(stderr.join('\n')).toContain('PLATFORM_ECS_SSH_KEY')
    expect(stderr.join('\n')).toContain('only production')
    expect(stderr.join('\n')).not.toContain(DISTINCTIVE_SECRET)
  })

  it('exits nonzero from the source entry without printing secret values', () => {
    const missing = spawnCli({})
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('PLATFORM_ORIGIN')
    expect(missing.stderr).toContain('PLATFORM_ECS_HOSTS')
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
  it('loads one operated identity and opens only durable PostgreSQL and Redis resources', () => {
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
    expect(productComposition).not.toContain('PersonalPairingProvider')
    expect(productComposition).not.toContain('DevelopmentKeylessPairingHandshakeProvider')
    expect(productComposition).not.toContain('RemoteRelayProvider')
    expect(productComposition).not.toContain('production-env-cli')
    expect(readFileSync(new URL('../src/production-env.ts', import.meta.url), 'utf8')).not.toContain('process.exit')
  })
})

describe('Platform release workflows', () => {
  it('validates Environment production without applying ECS unless deploy is set', () => {
    const workflow = loadWorkflow('.github/workflows/platform-deploy.yml')
    expect(workflow.on).toMatchObject({
      workflow_dispatch: {
        inputs: {
          deploy: { type: 'boolean', default: false },
        },
      },
    })
    const validate = job(workflow, 'validate')
    const deploy = job(workflow, 'deploy')
    expect(validate.environment).toBe('production')
    expect(deploy.environment).toBe('production')
    expect(deploy.needs).toBe('validate')
    expect(deploy.if).toBe('${{ inputs.deploy }}')
    const validateStep = steps(validate).find(step => typeof step.run === 'string'
      && step.run.includes('apps/platform/src/production-env-cli.ts'))
    if (validateStep === undefined) throw new TypeError('validate job must run production-env.ts')
    expect(String(validateStep.run)).toContain('--experimental-strip-types')
    if (!isRecord(validateStep.env)) throw new TypeError('validate step must define env')
    for (const name of PLATFORM_DEPLOY_REQUIRED_ENV) {
      expect(validateStep.env, name).toHaveProperty(name)
    }
    const apply = steps(deploy).find(step => typeof step.run === 'string' && step.run.includes('docker run'))
    if (apply === undefined) throw new TypeError('deploy job must run docker')
    expect(String(apply.run)).toContain('--log-opt max-size=20m')
    expect(String(apply.run)).toContain('--log-opt max-file=3')
    expect(String(apply.run)).toContain('dsh-loongcollector')
    expect(String(apply.run)).toContain('gestalt-platform')
    if (!isRecord(apply.env)) throw new TypeError('deploy apply step must define env')
    expect(apply.env).toHaveProperty('PLATFORM_SLS_ACCOUNT_ID')
    expect(String(apply.run)).toContain('100.100.100.200')
    expect(String(apply.run)).toContain('X-aliyun-ecs-metadata-token')
    expect(String(apply.run)).toContain('PLATFORM_SLS_ACCOUNT_ID')
    expect(String(apply.run)).toContain('loongcollector:v3.0.12.0-25723a1-aliyun')
    expect(String(apply.run)).toContain('/var/run/docker.sock')
    expect(String(apply.run)).toContain('/etc/ilogtail/conf/cn-hangzhou/ilogtail_config.json')
    if (!isRecord(workflow.jobs)) throw new TypeError('deploy workflow must define jobs')
    for (const [name, value] of Object.entries(workflow.jobs)) {
      if (!isRecord(value)) throw new TypeError(`${name} must be a job`)
      expect(value.environment, name).toBe('production')
    }
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
