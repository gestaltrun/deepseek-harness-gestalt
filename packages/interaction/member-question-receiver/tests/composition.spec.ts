import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseMemberQuestionId,
  parseMemberQuestionProjectId,
} from '@deepseek-ai/dsh-remote-protocol'
import FileMemberQuestionReceiver, { createAuthenticatedMemberQuestionIngress } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function boot(storagePath: string): Promise<{ context: Context; service: FileMemberQuestionReceiver }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-composition-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-invariants'",
    "- name: '@deepseek-ai/dsh-member-question-receiver/invariant'",
    "- name: '@deepseek-ai/dsh-member-question-receiver'",
    '  config:',
    `    storagePath: '${storagePath}'`,
    "    environment: 'development'",
    '    maxRecords: 8',
    '    terminalRetryMs: 10',
    '',
  ].join('\n'))
  const context = new Context()
  contexts.push(context)
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-invariants', InvariantRegistry],
    ['@deepseek-ai/dsh-member-question-receiver/invariant', await import('../src/invariant.ts')],
    ['@deepseek-ai/dsh-member-question-receiver', FileMemberQuestionReceiver],
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
  return {
    context,
    service: context.get('memberQuestionReceiver') as FileMemberQuestionReceiver,
  }
}

describe('real Loader composition', () => {
  it('registers, disposes, and remounts the durable receiver without losing its ledger', { timeout: 60_000 }, async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'dsh-member-question-receiver-state-'))
    roots.push(storagePath)
    const first = await boot(storagePath)
    const questionId = parseMemberQuestionId('composition-question')
    await createAuthenticatedMemberQuestionIngress(first.service)({
      authority: { accountId: 'composition-account' as PlatformAccountId },
      operation: {
        type: 'member-question',
        operationId: parseCompanionOperationId('composition-operation'),
        questionId,
        projectId: parseMemberQuestionProjectId('composition-project'),
        originSessionId: parseCompanionSessionId('composition-origin'),
        expiresAt: Number.MAX_SAFE_INTEGER,
        origin: {
          projectName: 'Composition',
          originSessionTitle: 'Loader',
          askerAccountId: 'asker',
          askerRole: 'member',
          askerDisplayName: 'Ask',
          askerAvatarUrl: 'https://example.test/ask.png',
        },
        background: 'Prove the real package composition.',
        questions: [{ id: 'q', question: 'Mounted?' }],
        references: [],
      },
    })
    const entry = [...first.context.loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-member-question-receiver')!
    await entry.fiber!.dispose()
    expect(first.context.get('memberQuestionReceiver')).toBeUndefined()
    expect(await readFile(join(storagePath, 'development', 'member-question-receiver.json'), 'utf8'))
      .toContain(questionId)

    const second = await boot(storagePath)
    expect((await second.service.snapshot()).pending.map(row => row.questionId)).toEqual([questionId])
  })
})
