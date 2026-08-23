/**
 * Workbench adapter, node half. After the better-sidebar snapshot registers
 * its prefs namespace, this plugin writes `tabsEnabled.browser: true` and
 * `browserInterceptLinks: false` so the official page chrome occupies the
 * snapshot browser tab.
 */

import type { Context } from '@deepseek-ai/cordis'
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
  fiber?: { await(): Promise<unknown> }
}

/** Loader face used only to join the snapshot row. */
interface SnapshotLoader {
  /** Live composed entries. */
  entries(): Iterable<SnapshotLoaderEntry>
}

const SNAPSHOT_ENTRY_ID = 'better-sidebar'
const SNAPSHOT_PACKAGE = '@deepseek-ai/dsh-client-better-sidebar'

/**
 * Whether one loader entry is the pinned workbench snapshot.
 * @param entry - composed loader entry.
 * @returns whether this entry is the snapshot host row.
 */
function isSnapshotEntry(entry: SnapshotLoaderEntry): boolean {
  return entry.options.id === SNAPSHOT_ENTRY_ID || entry.options.name === SNAPSHOT_PACKAGE
}

/**
 * Yield until the next event-loop turn so a not-yet-started snapshot fiber can appear.
 * @returns a promise that resolves on the next immediate callback.
 */
function nextImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Join the snapshot host row when its prefs namespace is not registered yet.
 * The snapshot injects `webServer` / `sessions` / `webRuntime` / `tools`, so
 * this adapter (settings-only) can apply first during `Promise.allSettled`.
 * Calling `entry.init()` would apply the snapshot twice and duplicate `/sidebar` routes.
 * @param ctx - Host context that may carry a loader.
 */
async function awaitSnapshotRegistration(ctx: Context): Promise<void> {
  const ns = settingsNamespace(SNAPSHOT_PREFS_NS)
  const loader = ctx.get('loader') as SnapshotLoader | undefined
  if (loader === undefined) return
  if (![...loader.entries()].some(isSnapshotEntry)) return
  while (ctx.settings.get(ns) === undefined) {
    const snapshot = [...loader.entries()].find(isSnapshotEntry)
    if (snapshot === undefined) return
    if (snapshot.fiber !== undefined) {
      await snapshot.fiber.await()
      return
    }
    await nextImmediate()
  }
}

/**
 * Force the snapshot browser tab on once its prefs namespace exists.
 * @param ctx - Host context that already composed settings and the snapshot.
 */
export async function apply(ctx: Context): Promise<void> {
  const ns = settingsNamespace(SNAPSHOT_PREFS_NS)
  if (ctx.settings.get(ns) === undefined) await awaitSnapshotRegistration(ctx)
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
