/**
 * Workbench adapter, node half. After the better-sidebar snapshot registers
 * its prefs namespace, this plugin writes `tabsEnabled.browser: true` and
 * `browserInterceptLinks: false` so the official page chrome occupies the
 * snapshot browser tab.
 */

import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SNAPSHOT_PREFS_NS, snapshotBrowserProductPatch, type SnapshotBrowserPrefs } from './snapshot-browser.ts'

/** Host plugin identity for cordis.yml rows. */
export const name = 'ui-workbench'

/** Settings must be present so the snapshot namespace can be patched. */
export const inject = ['settings']

/** Loader entry that owns the snapshot prefs namespace. */
interface SnapshotLoaderEntry {
  /** Entry options from the composed cordis.yml row. */
  options: { id?: string; name?: string }
  /** Live fiber once the loader has started this entry; do not call `init()`. */
  fiber?: Pick<Fiber, 'await' | 'state'>
}

/** Loader face used only to join the snapshot row. */
interface SnapshotLoader {
  /** Live composed entries. */
  entries(): Iterable<SnapshotLoaderEntry>
}

const SNAPSHOT_ENTRY_ID = 'ui-better-sidebar'
const SNAPSHOT_PACKAGE = '@deepseek-ai/dsh-client-ui-better-sidebar'

/**
 * Whether one loader entry is the pinned workbench snapshot.
 * @param entry - composed loader entry.
 * @returns whether this entry is the snapshot host row.
 */
function isSnapshotEntry(entry: SnapshotLoaderEntry): boolean {
  return entry.options.id === SNAPSHOT_ENTRY_ID || entry.options.name === SNAPSHOT_PACKAGE
}

/**
 * Observe one Loader or Cordis fiber transition while the snapshot is pending.
 * @param ctx - workbench plugin context whose disposal cancels the observation.
 * @returns the transition promise and an idempotent listener disposer.
 */
function nextSnapshotLifecycle(ctx: Context): { promise: Promise<boolean>; dispose(): void } {
  const settled = Promise.withResolvers<boolean>()
  const listeners = [
    ctx.on('internal/plugin', (fiber) => {
      finish(!(fiber === ctx.fiber && fiber.uid === null))
    }),
    ctx.on('internal/status', () => {
      finish(true)
    }),
    ctx.on('loader/partial-dispose', () => {
      finish(true)
    }),
  ]
  let done = false
  const cancel = ctx.effect(
    () => () => {
      finish(false)
    },
    'ui-workbench: await snapshot registration',
  )

  function finish(value: boolean): void {
    if (done) return
    done = true
    settled.resolve(value)
  }

  const dispose = (): void => {
    for (const listener of listeners) listener()
    void cancel()
  }
  return {
    promise: settled.promise.finally(dispose),
    dispose,
  }
}

/**
 * Join the snapshot host row when its prefs namespace is not registered yet.
 * The snapshot injects `webServer` / `sessions` / `webRuntime` / `tools`, so
 * this adapter (settings-only) can apply first during `Promise.allSettled`.
 * Calling `entry.init()` would apply the snapshot twice and duplicate `/sidebar` routes.
 * @param ctx - Host context that may carry a loader.
 * @returns `false` only when adapter disposal cancels the pending registration.
 */
async function awaitSnapshotRegistration(ctx: Context): Promise<boolean> {
  const ns = settingsNamespace(SNAPSHOT_PREFS_NS)
  const loader = ctx.get('loader') as SnapshotLoader | undefined
  if (loader === undefined) return true
  if (![...loader.entries()].some(isSnapshotEntry)) return true
  while (true) {
    if (ctx.fiber.uid === null) return false
    if (ctx.settings.get(ns) !== undefined) return true
    const entries = [...loader.entries()]
    const snapshot = entries.find(isSnapshotEntry)
    if (snapshot === undefined) return true
    if (snapshot.fiber?.state === FiberState.FAILED) await snapshot.fiber.await()
    if (snapshot.fiber !== undefined && snapshot.fiber.state !== FiberState.PENDING) {
      await snapshot.fiber.await()
      return ctx.fiber.uid !== null
    }
    const lifecycle = nextSnapshotLifecycle(ctx)
    const current = [...loader.entries()].find(isSnapshotEntry)
    if (
      ctx.settings.get(ns) !== undefined
      || current !== snapshot
      || current.fiber !== snapshot.fiber
      || (current.fiber !== undefined && current.fiber.state !== FiberState.PENDING)
    ) {
      lifecycle.dispose()
      continue
    }
    if (!await lifecycle.promise) return false
  }
}

/**
 * Force the snapshot browser tab on once its prefs namespace exists.
 * @param ctx - Host context that already composed settings and the snapshot.
 */
export async function apply(ctx: Context): Promise<void> {
  const ns = settingsNamespace(SNAPSHOT_PREFS_NS)
  if (ctx.settings.get(ns) === undefined) {
    if (!await awaitSnapshotRegistration(ctx) || ctx.fiber.uid === null) return
  }
  const current = ctx.settings.get(ns) as SnapshotBrowserPrefs | undefined
  if (current === undefined) {
    throw new Error(
      'ui-workbench: dsh-better-sidebar settings namespace is not registered; mount the snapshot host row first',
    )
  }
  const patch = snapshotBrowserProductPatch(current)
  if (patch === undefined) return
  await ctx.settings.update(ns, patch)
}
