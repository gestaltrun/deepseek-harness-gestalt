/** Keyless Account and membership provider for the last-window Offline scenario. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
} from '@deepseek-ai/dsh-platform-account'
import {
  MemoryAccountBackend,
  MemoryAccountInvalidationBus,
  PlatformAccount,
  type GitHubIdentityProvider,
} from '@deepseek-ai/dsh-platform-account-core'
import ProjectMembershipCore from '@deepseek-ai/dsh-project-membership-core'

export const ENVIRONMENT = selectPlatformEnvironment(validatePlatformEnvironmentPair({
  development: {
    environment: 'development', origin: 'https://platform.dev.example.com',
    callbackUrl: 'https://platform.dev.example.com/v1/account/oauth/github/callback',
    githubClientId: 'presence-close-development', credentialReference: 'credentials://development',
    databaseIdentity: 'presence-close-database-development', identityNamespace: 'presence-close-development',
  },
  production: {
    environment: 'production', origin: 'https://platform.example.com',
    callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
    githubClientId: 'presence-close-production', credentialReference: 'credentials://production',
    databaseIdentity: 'presence-close-database-production', identityNamespace: 'presence-close-production',
  },
}), 'development')

const GITHUB_USERS = [
  { providerSubject: 13994321, login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
  { providerSubject: 721119, login: 'mona', avatarUrl: 'https://avatars.example/mona' },
]

/** Cordis name for the keyless Account and membership provider. */
export const name = 'member-presence-close-keyless-provider'

/** Mount in-memory Account and a temp-backed membership store. */
export async function apply(ctx: Context): Promise<void> {
  let served = 0
  const github: GitHubIdentityProvider = {
    environment: ENVIRONMENT,
    authorizationUrl: () => 'https://github.com/login/oauth/authorize',
    async exchange() {
      const user = GITHUB_USERS[served]
      served += 1
      if (user === undefined) throw new Error('presence-close provider ran out of GitHub users')
      return user
    },
  }
  new PlatformAccount(ctx, {
    backend: new MemoryAccountBackend(ENVIRONMENT.databaseIdentity),
    invalidation: new MemoryAccountInvalidationBus(),
    github,
    environment: ENVIRONMENT,
    config: { tokenSigningKey: Buffer.alloc(32, 7), pollingSigningKey: Buffer.alloc(32, 9) },
  })
  const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-presence-close-'))
  new ProjectMembershipCore(ctx, { storagePath, environment: 'development' })
  ctx.effect(() => async () => {
    await rm(storagePath, { recursive: true, force: true })
  }, 'member-presence-close: remove temp membership store')
}
