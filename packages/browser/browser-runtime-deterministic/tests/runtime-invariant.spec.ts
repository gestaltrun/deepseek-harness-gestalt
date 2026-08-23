import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  BrowserInstanceId,
  BrowserProfileId,
  type BrowserRuntimeState,
  BrowserTabId,
  browserTargetKey,
  BrowserWorkspaceId,
} from '@deepseek-ai/dsh-browser-runtime'
import BrowserRuntimeDeterministic from '@deepseek-ai/dsh-browser-runtime-deterministic'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as BrowserRuntimeDeterministicInvariant from '../src/invariant.ts'
import {
  registerRuntimeStateReader,
  registerRuntimeStateValidator,
  RUNTIME_STATE_OWNER,
  runtimeStateReader,
  runtimeStateValidator,
  type RuntimeStateOwner,
} from '../src/runtime-state.ts'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PAGE = { url: 'https://one.test/', title: 'One', text: 'one', screenshotPngBase64: PNG_1X1 }

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry).await()
  await ctx.plugin(BrowserRuntimeDeterministic, { pages: [PAGE] }).await()
  return ctx
}

async function mountInvariant(ctx: Context): Promise<ReturnType<Context['plugin']>> {
  const fiber = ctx.plugin(BrowserRuntimeDeterministicInvariant)
  await fiber.await()
  return fiber
}

function ownerOf(ctx: Context): RuntimeStateOwner {
  const owner = (ctx.browserRuntime as typeof ctx.browserRuntime & {
    readonly [RUNTIME_STATE_OWNER]?: RuntimeStateOwner
  })[RUNTIME_STATE_OWNER]
  if (owner === undefined) throw new Error('expected deterministic Browser Runtime owner')
  return owner
}

describe('deterministic Browser Runtime invariant lifecycle', () => {
  it('fails load against a different Browser Runtime Provider', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry).await()
    ctx.provide('browserRuntime', {} as never)
    await expect(ctx.plugin(BrowserRuntimeDeterministicInvariant).await())
      .rejects.toThrow(/requires its own Provider implementation/)

    const missingReader = new Context()
    await missingReader.plugin(InvariantRegistry).await()
    missingReader.provide('browserRuntime', {
      [RUNTIME_STATE_OWNER]: Object.freeze({}) as RuntimeStateOwner,
    } as never)
    await expect(missingReader.plugin(BrowserRuntimeDeterministicInvariant).await())
      .rejects.toThrow(/requires its Provider state reader/)
  })

  it('rejects an impossible initial transition before state commit', async () => {
    const ctx = await setup()
    await mountInvariant(ctx)
    const validate = runtimeStateValidator(ownerOf(ctx))
    if (validate === undefined) throw new Error('expected deterministic Browser Runtime validator')
    const target = {
      profileId: BrowserProfileId('initial-profile'),
      workspaceId: BrowserWorkspaceId('initial-workspace'),
      browserId: BrowserInstanceId('initial-browser'),
      tabId: BrowserTabId('initial-tab'),
    }

    expect(() => { validate({ status: 'closed', target, revision: 0 }) })
      .toThrow(/must begin with an open revision 0 state/)
    await expect(ctx.browserRuntime.create({ profile: 'temporary' })).resolves.toMatchObject({ revision: 0 })
  })

  it('seeds and reloads its pre-commit validator from authoritative live state', async () => {
    const ctx = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const firstInvariant = await mountInvariant(ctx)
    const firstValidate = runtimeStateValidator(ownerOf(ctx))
    if (firstValidate === undefined) throw new Error('expected deterministic Browser Runtime validator')
    expect(() => { firstValidate({ ...created, revision: 2 }) })
      .toThrow(/revision 2 must follow 0/)

    const navigated = await ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: PAGE.url,
    })
    expect(await ctx.browserRuntime.observe({ target: created.target })).toEqual(navigated)

    await firstInvariant.dispose()
    await mountInvariant(ctx)
    const reloadedValidate = runtimeStateValidator(ownerOf(ctx))
    if (reloadedValidate === undefined) throw new Error('expected reloaded Browser Runtime validator')
    expect(() => { reloadedValidate({ ...navigated, revision: 3 }) })
      .toThrow(/revision 3 must follow 1/)
    const focused = await ctx.browserRuntime.focus({
      target: created.target,
      expectedRevision: navigated.revision,
    })
    expect(await ctx.browserRuntime.observe({ target: created.target })).toEqual(focused)
  })

  it('rejects identity, revision, and terminal-to-open discontinuities before commit', async () => {
    const wrongIdentity = await setup()
    await mountInvariant(wrongIdentity)
    const first = await wrongIdentity.browserRuntime.create({ profile: 'temporary' })
    const validateIdentity = runtimeStateValidator(ownerOf(wrongIdentity))
    if (validateIdentity === undefined) throw new Error('expected deterministic Browser Runtime validator')
    expect(() => {
      validateIdentity({
        ...first,
        target: { ...first.target, tabId: BrowserTabId('different-tab') },
        revision: 1,
      })
    }).toThrow(/must begin with an open revision 0 state/)
    expect(() => {
      validateIdentity({
        status: 'unavailable',
        target: first.target,
        revision: 1,
        reason: 'crashed',
        reconnecting: false,
      })
    }).toThrow(/cannot publish an unavailable state/)

    const skippedRevision = await setup()
    await mountInvariant(skippedRevision)
    const revisionZero = await skippedRevision.browserRuntime.create({ profile: 'temporary' })
    const validateRevision = runtimeStateValidator(ownerOf(skippedRevision))
    if (validateRevision === undefined) throw new Error('expected deterministic Browser Runtime validator')
    expect(() => { validateRevision({ ...revisionZero, revision: 2 }) })
      .toThrow(/revision 2 must follow 0/)

    const terminal = await setup()
    const terminalOpen = await terminal.browserRuntime.create({ profile: 'temporary' })
    await terminal.browserRuntime.close({ target: terminalOpen.target, expectedRevision: terminalOpen.revision })
    await mountInvariant(terminal)
    const validateTerminal = runtimeStateValidator(ownerOf(terminal))
    if (validateTerminal === undefined) throw new Error('expected deterministic Browser Runtime validator')
    expect(() => { validateTerminal(terminalOpen) })
      .toThrow(/terminal state cannot reopen/)
  })

  it('leaves authoritative state unchanged when a pre-commit validator rejects', async () => {
    const ctx = await setup()
    const created = await ctx.browserRuntime.create({ profile: 'temporary' })
    const disposeValidator = registerRuntimeStateValidator(ownerOf(ctx), () => {
      throw new InvariantError(
        '@deepseek-ai/dsh-browser-runtime-deterministic',
        'forced pre-commit rejection',
      )
    })

    await expect(ctx.browserRuntime.navigate({
      target: created.target,
      expectedRevision: created.revision,
      url: PAGE.url,
    })).rejects.toMatchObject({ code: 'INVARIANT' })
    await expect(ctx.browserRuntime.observe({ target: created.target })).resolves.toEqual(created)
    disposeValidator()
  })

  it('scopes readers to isolated Provider owners and tears down only the disposed Provider', async () => {
    const root = new Context()
    const left = root.isolate('browserRuntime')
    const right = root.isolate('browserRuntime')
    const leftFiber = await left.plugin(BrowserRuntimeDeterministic, { idPrefix: 'left', pages: [PAGE] })
    const rightFiber = await right.plugin(BrowserRuntimeDeterministic, { idPrefix: 'right', pages: [PAGE] })
    const leftOwner = ownerOf(left)
    const rightOwner = ownerOf(right)
    expect(leftOwner).not.toBe(rightOwner)

    const leftState = await left.browserRuntime.create({ profile: 'temporary' })
    const rightState = await right.browserRuntime.create({ profile: 'temporary' })
    expect(runtimeStateReader(leftOwner)?.().get(browserTargetKey(leftState.target))).toEqual(leftState)
    expect(runtimeStateReader(rightOwner)?.().get(browserTargetKey(rightState.target))).toEqual(rightState)

    await leftFiber.dispose()
    expect(runtimeStateReader(leftOwner)).toBeUndefined()
    expect(runtimeStateReader(rightOwner)?.().get(browserTargetKey(rightState.target))).toEqual(rightState)
    await rightFiber.dispose()
  })

  it('uses registration identity for replacement disposal and rejects missing or duplicate owners', () => {
    const owner = Object.freeze({}) as RuntimeStateOwner
    const otherOwner = Object.freeze({}) as RuntimeStateOwner
    const replacementState = { status: 'closed', target: {
      profileId: BrowserProfileId('replacement-profile'),
      workspaceId: BrowserWorkspaceId('replacement-workspace'),
      browserId: BrowserInstanceId('replacement-browser'),
      tabId: BrowserTabId('replacement-tab'),
    }, revision: 1 } satisfies BrowserRuntimeState
    const initialStates = new Map<string, BrowserRuntimeState>()
    const replacementStates = new Map([[browserTargetKey(replacementState.target), replacementState]])
    const disposeInitial = registerRuntimeStateReader(owner, () => initialStates)
    const disposeOther = registerRuntimeStateReader(otherOwner, () => replacementStates)
    expect(() => registerRuntimeStateReader(owner, () => replacementStates)).toThrow(/already registered/)

    disposeInitial()
    const disposeReplacement = registerRuntimeStateReader(owner, () => replacementStates)
    disposeInitial()
    expect(runtimeStateReader(owner)?.()).toEqual(replacementStates)
    expect(runtimeStateReader(otherOwner)?.()).toEqual(replacementStates)

    const validate = (): undefined => undefined
    expect(() => registerRuntimeStateValidator(Object.freeze({}) as RuntimeStateOwner, validate))
      .toThrow(/has no state reader/)
    const disposeValidator = registerRuntimeStateValidator(owner, validate)
    expect(() => registerRuntimeStateValidator(owner, validate)).toThrow(/already registered/)
    disposeValidator()
    const replacementValidator = (): undefined => undefined
    const disposeReplacementValidator = registerRuntimeStateValidator(owner, replacementValidator)
    disposeValidator()
    expect(runtimeStateValidator(owner)).toBe(replacementValidator)

    disposeReplacementValidator()
    disposeReplacement()
    disposeOther()
  })
})
