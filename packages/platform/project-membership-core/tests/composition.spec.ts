/**
 * REAL Loader composition: a keyless cordis.yml boots the invariants service,
 * both project-membership companions, and the file-backed provider, and the
 * suite asserts observable durable outcomes across two boot generations over
 * one storage root. Only nondeterminism (uuids, wall-clock) is external.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import ProjectMembershipCore from '../src/index.ts'

const alice = 'assembled-alice' as PlatformAccountId
const bob = 'assembled-bob' as PlatformAccountId

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const loaded of contexts.splice(0).reverse()) await loaded.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Booted {
  readonly service: InstanceType<typeof ProjectMembershipCore>
}

/**
 * Boot one real Loader generation from cordis.yml text. The modules map plays
 * the package resolution role an installed dsh app provides; every listed
 * plugin still goes through genuine Loader config validation and effects.
 * @param storagePath - durable storage root handed to the provider config.
 * @param environment - environment written into the provider config.
 * @returns the mounted provider service once the boot assertions pass.
 */
async function boot(storagePath: string, environment: string): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-project-membership-composition-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const yml = [
    "- name: '@deepseek-ai/dsh-invariants'",
    "- name: '@deepseek-ai/dsh-project-membership/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-core/invariant'",
    "- name: '@deepseek-ai/dsh-project-membership-core'",
    '  config:',
    `    storagePath: '${storagePath}'`,
    `    environment: '${environment}'`,
    '',
  ].join('\n')
  await writeFile(configPath, yml)
  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-invariants', InvariantRegistry],
    ['@deepseek-ai/dsh-project-membership/invariant', await import('@deepseek-ai/dsh-project-membership/invariant')],
    ['@deepseek-ai/dsh-project-membership-core/invariant', await import('../src/invariant.ts')],
    ['@deepseek-ai/dsh-project-membership-core', ProjectMembershipCore],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const service = context.get('projectMembership') as InstanceType<typeof ProjectMembershipCore>
  expect(service.storageFile).toBe(join(storagePath, environment, 'project-membership.json'))
  // Both companions require the `invariants` service at load; settlement proves registration.
  expect(context.get('invariants')).toBeInstanceOf(InvariantRegistry)
  return { service }
}

describe('real Loader composition of project-membership definition + provider', () => {
  it('boots cordis.yml, commits durable state on disk, and survives a second boot generation', { timeout: 60_000 }, async () => {
    const storageRoot = join(await mkdtemp(join(tmpdir(), 'dsh-project-membership-durable-')), 'state')
    roots.push(storageRoot)

    // First generation: create, invite, accept.
    const first = await boot(storageRoot, 'development')
    const created = await first.service.createProject(alice, {
      name: 'Assembled',
      remoteUrl: 'git@github.com:Org/assembled.git',
    })
    await first.service.invite(alice, { projectId: created.id, inviteeAccountId: bob, grantedRole: 'member' })
    const pending = await first.service.pendingInvitationsFor(bob)
    const joined = await first.service.acceptInvitation(bob, {
      invitationId: pending[0]!.id,
      link: { workspaceName: 'bob-assembled' },
    })
    expect(joined.role).toBe('member')

    // Observable durable outcome: the environment document exists with both rows committed.
    const document = JSON.parse(await readFile(first.service.storageFile, 'utf8')) as {
      formatVersion: number
      projects: Array<{ id: string; boundRemoteUrl: string; rosterVersion: number }>
      memberships: Array<{ accountId: string; link?: { workspaceName: string } }>
      invitations: Array<{ state: string }>
    }
    expect(document.formatVersion).toBe(1)
    expect(document.projects.map(row => row.boundRemoteUrl)).toEqual(['git@github.com:Org/assembled'])
    expect(document.memberships.map(row => row.accountId).sort()).toEqual([alice, bob].sort())
    expect(document.memberships.find(row => row.accountId === bob)?.link?.workspaceName).toBe('bob-assembled')
    expect(document.invitations.every(row => row.state !== 'pending')).toBe(true)
    // POSIX mode bits are the durable-outcome observable; Windows stat reports
    // the default 0o666 for every file and carries no permission signal.
    if (process.platform !== 'win32') {
      expect((await stat(first.service.storageFile)).mode & 0o077).toBe(0)
    }
    expect(await first.service.rosterVersion(created.id)).toBeGreaterThan(0)

    // Second generation over the same root: no re-registration conflicts, full state recovery.
    const second = await boot(storageRoot, 'development')
    const recovered = await second.service.roster(alice, created.id)
    expect(recovered.project.name).toBe('Assembled')
    expect(recovered.members.map(row => row.accountId).sort()).toEqual([alice, bob].sort())
    expect(await second.service.pendingInvitationsFor(bob)).toEqual([])

    // The invariant companions stayed mounted through both boots: removing nobody keeps versions monotonic.
    const versionBeforeTagEdit = await second.service.rosterVersion(created.id)
    const bobRow = recovered.members.find(row => row.accountId === bob)!
    await second.service.setMemberTags(alice, {
      membershipId: bobRow.id,
      tags: ['on-call' as import('@deepseek-ai/dsh-project-membership').FunctionTag],
    })
    expect(await second.service.rosterVersion(created.id)).toBe(versionBeforeTagEdit + 1)
  })

  it('fails loud at load when the configured environment is not development or production', async () => {
    const storageRoot = join(await mkdtemp(join(tmpdir(), 'dsh-project-membership-invalid-')), 'state')
    roots.push(storageRoot)
    let failure: unknown
    try {
      await boot(storageRoot, 'staging')
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain('environment')
    expect(String(failure)).toContain('expected "development" | "production"')
  })
})
