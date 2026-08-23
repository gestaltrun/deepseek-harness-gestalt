/** Packaged-app delivery of full Personal Pairing links. */

import { App } from '@capacitor/app'

interface MobileAppLinks {
  getLaunchUrl(): Promise<{ url: string } | undefined>
  addListener(
    eventName: 'appUrlOpen',
    listener: (event: { url: string }) => void,
  ): Promise<{ remove(): Promise<void> }>
}

/** Readiness-gated native URL owner for one Mobile pairing lifecycle. */
export interface MobilePairingDeepLinkBinding {
  /** Admit queued URLs only after the signed-in pairing controller is active. */
  setReady(ready: boolean): Promise<void>
  /** Remove native listeners and drain work already admitted while ready. */
  dispose(): Promise<void>
}

/** Bind launch and foreground URLs to the one full-link pairing path. */
export function bindMobilePairingDeepLinks(
  completeLink: (link: string, signal: AbortSignal) => Promise<void>,
  options: {
    app?: MobileAppLinks
    onError?: (error: unknown) => void
    isTerminalError?: (error: unknown) => boolean
  } = {},
): MobilePairingDeepLinkBinding {
  const app = options.app ?? App
  let active = true
  let ready = false
  let generation = 0
  let controller: AbortController | undefined
  let processing: Promise<void> | undefined
  const pending: string[] = []
  const queued = new Set<string>()
  const seen = new Set<string>()
  const deliver = (url: string): void => {
    if (!active || seen.has(url) || queued.has(url)) return
    queued.add(url)
    pending.push(url)
    drain()
  }
  const drain = (): void => {
    const lease = controller
    const leaseGeneration = generation
    if (!active || !ready || lease === undefined || processing !== undefined) return
    processing = (async () => {
      const url = pending.shift()
      if (url === undefined) return
      try {
        await completeLink(pairingLinkFromAppUrl(url), lease.signal)
        if (!lease.signal.aborted && leaseGeneration === generation) markSeen(url)
        else pending.unshift(url)
      } catch (error) {
        if (lease.signal.aborted || leaseGeneration !== generation) {
          pending.unshift(url)
        } else if (options.isTerminalError?.(error) === true || error instanceof TypeError) {
          markSeen(url)
          options.onError?.(error)
        } else {
          pending.unshift(url)
          ready = false
          options.onError?.(error)
        }
      }
    })().finally(() => {
      processing = undefined
      if (active && ready && pending.length > 0) drain()
    })
  }
  const markSeen = (url: string): void => {
    queued.delete(url)
    seen.add(url)
    if (seen.size > 32) seen.delete(seen.values().next().value as string)
  }
  const listener = app.addListener('appUrlOpen', (event) => { deliver(event.url) })
  const launch = app.getLaunchUrl().then((value) => {
    if (value !== undefined) deliver(value.url)
  }).catch((error: unknown) => { options.onError?.(error) })
  return {
    async setReady(nextReady) {
      const nextGeneration = ++generation
      ready = false
      controller?.abort(new DOMException('Mobile pairing ready lease ended', 'AbortError'))
      await processing
      if (!active || generation !== nextGeneration) return
      if (!nextReady) {
        controller = undefined
        return
      }
      controller = new AbortController()
      ready = true
      drain()
    },
    async dispose() {
      generation += 1
      active = false
      ready = false
      controller?.abort(new DOMException('Mobile pairing deep-link owner disposed', 'AbortError'))
      await processing
      pending.length = 0
      queued.clear()
      const handle = await listener.catch(() => undefined)
      await handle?.remove()
      await launch
    },
  }
}

function pairingLinkFromAppUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'deepseek-gestalt:') return value
  if (url.hostname !== 'pair') throw new TypeError('Mobile application deep link is not a pairing link')
  const pairingLink = url.searchParams.get('link')
  if (pairingLink === null || pairingLink.length === 0) {
    throw new TypeError('Mobile pairing deep link omitted the full one-time link')
  }
  return pairingLink
}
