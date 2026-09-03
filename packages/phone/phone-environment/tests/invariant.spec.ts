import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { PhoneEnvironmentSnapshot } from '../src/types.ts'
import * as PhoneEnvironmentInvariant from '../src/invariant.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

function initialSnapshot(): PhoneEnvironmentSnapshot {
  return {
    revision: 1,
    enabled: false,
    runtime: { kind: 'missing', targetVersion: '1.0.5' },
    platforms: { android: { kind: 'deferred' }, ios: { kind: 'deferred' } },
  }
}

async function mountInvariant(): Promise<{
  initial: PhoneEnvironmentSnapshot
  publish: (snapshot: PhoneEnvironmentSnapshot) => void
}> {
  const context = new Context()
  contexts.push(context)
  const initial = initialSnapshot()
  let listener: ((snapshot: PhoneEnvironmentSnapshot) => void) | undefined
  context.provide('phoneEnvironment', {
    snapshot: () => initial,
    onChanged: (next: (snapshot: PhoneEnvironmentSnapshot) => void) => {
      listener = next
      return () => { listener = undefined }
    },
  } as never)
  await context.plugin(InvariantRegistry).await()
  await context.plugin(PhoneEnvironmentInvariant).await()
  if (listener === undefined) throw new Error('phone environment invariant did not subscribe')
  return { initial, publish: listener }
}

describe('phone environment invariant companion', () => {
  it('accepts consecutive snapshots carrying an observable change', async () => {
    const { publish } = await mountInvariant()
    expect(() => {
      publish({
        ...initialSnapshot(),
        revision: 2,
        enabled: true,
      })
    }).not.toThrow()
  })

  it('rejects a skipped revision', async () => {
    const { publish } = await mountInvariant()
    expect(() => {
      publish({
        ...initialSnapshot(),
        revision: 3,
        enabled: true,
      })
    }).toThrow(/snapshot revision jumped from 1 to 3/)
  })

  it('rejects a new revision without an observable change', async () => {
    const { initial: previous, publish } = await mountInvariant()
    expect(() => {
      publish({
        revision: 2,
        enabled: previous.enabled,
        runtime: previous.runtime,
        platforms: previous.platforms,
      })
    }).toThrow(/snapshot with no observable change/)
  })
})
