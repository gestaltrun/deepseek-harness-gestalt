/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-phone`.
 * @module @deepseek-ai/dsh-client-ui-phone/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  assertPhoneTabSymmetry, installPhoneTab,
  PHONE_TAB_ID, type PhoneTabView,
} from './client/registry.ts'
import { createHttpPhoneListingSource } from './client/phone-listing.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-phone'

/** Cordis companion plugin name. */
export const name = 'client-ui-phone-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Same-process fake of the better-sidebar registry with the production
 * duplicate-registration and disposer semantics: a second registerTab for
 * the same id throws, and the returned disposer removes exactly its own
 * descriptor. First registration and first removal expose promises so the
 * probe settles on observable registry facts instead of fiber-state races.
 * Exported for this package's suites, which share the exact semantics.
 */
export class RecordingSidebar {
  private readonly tabs = new Map<string, unknown>()
  private readonly registered = Promise.withResolvers<void>()
  private readonly unregistered = Promise.withResolvers<void>()

  /** Register one tab descriptor keyed by id; duplicates throw loud. */
  registerTab(descriptor: { readonly id: string }): () => void {
    if (this.tabs.has(descriptor.id)) {
      throw new Error(`tab type "${descriptor.id}" already registered`)
    }
    this.tabs.set(descriptor.id, descriptor)
    this.registered.resolve()
    return () => {
      if (this.tabs.get(descriptor.id) === descriptor) {
        this.tabs.delete(descriptor.id)
        this.unregistered.resolve()
      }
    }
  }

  getTab(id: string): unknown {
    return this.tabs.get(id)
  }

  /** Resolves after the first successful registration. */
  get whenRegistered(): Promise<void> {
    return this.registered.promise
  }

  /** Resolves after the first observed removal. */
  get whenUnregistered(): Promise<void> {
    return this.unregistered.promise
  }
}

/**
 * Chrome stand-in for the invariant run: registry symmetry depends on the
 * descriptor identity and the fiber lifecycle, not on which component rides
 * it; the styled body is asserted by this package's jsdom specs.
 */
const stubView: PhoneTabView = {
  icon: () => null,
  component: () => null,
}

/**
 * Prove the owned relationship on live cordis fibers in the registration's
 * own child context: activation registers the `phone` tab, disposal leaves
 * no residue behind. The fake publisher activates before the dependent
 * fiber so the injected service resolves against an active owner, and both
 * settle points read the registry itself. A hosting context that already
 * publishes `betterSidebar` is exercising this registration itself (the
 * package suites), so the probe yields instead of colliding with it.
 * @param ctx - child context owning this invariant registration.
 * @param fail - reporter bound to this package.
 */
const install: InvariantInstaller = async (ctx: Context, fail: InvariantFailure): Promise<void> => {
  if (ctx.get('betterSidebar') !== undefined) return
  const sidebar = new RecordingSidebar()
  await ctx.plugin({
    apply: (providerCtx: Context): void => { providerCtx.provide('betterSidebar', sidebar) },
  }).await()
  const dependent = ctx.plugin({
    inject: ['betterSidebar'],
    apply: (pluginCtx: Context): void => {
      installPhoneTab(pluginCtx, {
        source: createHttpPhoneListingSource(),
        view: stubView,
        isEnabled: () => false,
        gate: { snapshot: () => false, subscribe: () => () => undefined },
        createController: () => {
          throw new Error('the symmetry probe never renders a tab body')
        },
      })
    },
  })
  await dependent.await()
  await sidebar.whenRegistered
  if (sidebar.getTab(PHONE_TAB_ID) === undefined) {
    fail(`the "${PHONE_TAB_ID}" tab is missing after the plugin fiber activated`)
  }
  await dependent.dispose()
  // The tab disposer runs during fiber disposal; settle on the observed
  // removal itself rather than trusting the dispose promise ordering.
  await (sidebar.getTab(PHONE_TAB_ID) === undefined
    ? Promise.resolve()
    : sidebar.whenUnregistered)
  assertPhoneTabSymmetry({ mounted: true, survivedDispose: sidebar.getTab(PHONE_TAB_ID) !== undefined }, fail)
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
