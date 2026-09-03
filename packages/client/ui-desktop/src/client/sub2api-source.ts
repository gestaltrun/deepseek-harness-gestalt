/** Observable Sub2API component snapshot for the Desktop offer card. */

import type { DesktopBridge, DesktopSub2ApiSnapshot } from '../protocol.ts'
import {
  bindDesktopSnapshot,
  createDesktopSnapshotSource,
  type DesktopSnapshotSource,
} from './snapshot-source.ts'

/** Renderer-side Sub2API component source. */
export type DesktopSub2ApiSource = DesktopSnapshotSource<DesktopSub2ApiSnapshot>

/** Initial missing state before the Desktop Host answers. */
export const INITIAL_SUB2API_SNAPSHOT: DesktopSub2ApiSnapshot = Object.freeze({
  state: 'missing',
  enabled: true,
})

/**
 * Create the source consumed through the Settings slot hook compartment.
 * @param onListenerError - reports one failing subscriber without skipping later subscribers.
 * @returns mutable snapshot source owned by the Desktop UI composition.
 */
export function createDesktopSub2ApiSource(
  onListenerError: (error: unknown) => void = (error) => {
    console.error('sub2api subscriber failed', error)
  },
): DesktopSub2ApiSource {
  return createDesktopSnapshotSource(INITIAL_SUB2API_SNAPSHOT, onListenerError)
}

/**
 * Bind Host reads and pushes without allowing a late initial read to win.
 * @param source - renderer snapshot source to update.
 * @param desktop - preload Sub2API read and subscription methods.
 * @param onError - reports failure of the initial Host read.
 * @returns disposer for the Host snapshot subscription.
 */
export function bindDesktopSub2Api(
  source: DesktopSub2ApiSource,
  desktop: Pick<DesktopBridge, 'sub2ApiGetSnapshot' | 'onSub2ApiSnapshot'>,
  onError: (error: unknown) => void = (error) => {
    console.error('failed to read Sub2API component state', error)
  },
): () => void {
  return bindDesktopSnapshot(
    source,
    listener => desktop.onSub2ApiSnapshot(listener),
    () => desktop.sub2ApiGetSnapshot(),
    onError,
  )
}
