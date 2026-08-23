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
  setReady(ready: boolean): void
  /** Remove native listeners and drain work already admitted while ready. */
  dispose(): Promise<void>
}

/** Bind launch and foreground URLs to the one full-link pairing path. */
export function bindMobilePairingDeepLinks(
  completeLink: (link: string) => Promise<void>,
  options: {
    app?: MobileAppLinks
    onError?: (error: unknown) => void
  } = {},
): MobilePairingDeepLinkBinding {
  const app = options.app ?? App
  let active = true
  let ready = false
  let processing: Promise<void> | undefined
  const pending: string[] = []
  const seen = new Set<string>()
  const deliver = (url: string): void => {
    if (!active || seen.has(url)) return
    seen.add(url)
    if (seen.size > 32) seen.delete(seen.values().next().value as string)
    pending.push(url)
    drain()
  }
  const drain = (): void => {
    if (!active || !ready || processing !== undefined) return
    processing = (async () => {
      const url = pending.shift()
      if (url === undefined) return
      try { await completeLink(pairingLinkFromAppUrl(url)) } catch (error) { options.onError?.(error) }
    })().finally(() => {
      processing = undefined
      if (active && ready && pending.length > 0) drain()
    })
  }
  const listener = app.addListener('appUrlOpen', (event) => { deliver(event.url) })
  const launch = app.getLaunchUrl().then((value) => {
    if (value !== undefined) deliver(value.url)
  }).catch((error: unknown) => { options.onError?.(error) })
  return {
    setReady(nextReady) {
      ready = nextReady
      drain()
    },
    async dispose() {
      active = false
      pending.length = 0
      const handle = await listener.catch(() => undefined)
      await handle?.remove()
      await launch
      await processing
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
