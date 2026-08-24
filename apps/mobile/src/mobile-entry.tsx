/** Shipped React composition for the Mobile application. */

import { StrictMode, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { MobileAccount } from './MobileAccount.tsx'
import type { MobilePairingActions } from './MobilePairing.tsx'
import type { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import { MobileCompanionSurface } from './companion-surface.ts'
import type { MobileCompanionPresentation } from './companion-history.ts'
import { LiveMobilePresentationClock, type MobilePresentationClock } from './mobile-clock.ts'

/** Product dependencies resolved before the Mobile React tree is mounted. */
export interface MobileEntryComposition {
  /** Current Mobile installation lifecycle controller. */
  installation: PlatformAccountInstallation
  /** Personal Pairing adapter available after sign-in. */
  pairing?: MobilePairingActions
  /** Current physical-connection synchronization authority. */
  companion: CompanionForegroundRuntime
  /** Injectable presentation clock; production defaults to the live system clock. */
  clock?: MobilePresentationClock | undefined
}

/** Mounted product entry and its authenticated Desktop projection receiver. */
export interface MountedMobileEntry {
  /** Surface receiver handed only to the authenticated Companion decoder. */
  companionSurface: MobileCompanionSurface
  /** Remove the mounted React tree. */
  unmount(): void
}

/**
 * Mount the shipped Mobile composition.
 * @param container - validated Mobile root element.
 * @param composition - product-owned account, pairing, and Companion services.
 * @returns mounted product entry and authenticated Desktop projection receiver.
 */
export function mountMobileEntry(container: Element, composition: MobileEntryComposition): MountedMobileEntry {
  const companionSurface = new MobileCompanionSurface(composition.companion)
  const clock = composition.clock ?? new LiveMobilePresentationClock()
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <MobileEntry composition={composition} companionSurface={companionSurface} clock={clock} />
    </StrictMode>,
  )
  return { companionSurface, unmount: () => { root.unmount() } }
}

function MobileEntry({
  composition,
  companionSurface,
  clock,
}: {
  composition: MobileEntryComposition
  companionSurface: MobileCompanionSurface
  clock: MobilePresentationClock
}): ReactNode {
  const projection = useSyncExternalStore(
    listener => companionSurface.subscribe(listener),
    () => companionSurface.getSnapshot(),
  )
  const companionState = useSyncExternalStore(
    listener => composition.companion.subscribe(listener),
    () => composition.companion.getState(),
  )
  const locale = navigator.languages.some(language => language.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
  const theme = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const authenticated: MobileCompanionPresentation | undefined = projection.desktopName === undefined
    ? undefined
    : {
      desktopName: projection.desktopName,
      connection: companionState.socketOpen && companionState.synchronized ? 'online' : 'offline',
      ...(companionState.connectionFailure === undefined
        ? {} : { connectionFailure: companionState.connectionFailure }),
      sessions: projection.sessions,
      workspaces: projection.workspaces,
      conversations: projection.conversations,
      loadImage: companionSurface.loadImage,
      canMutate: companionSurface.mayMutate(),
      search: projection.search,
      attachment: projection.attachment,
      operationFailure: projection.operationFailure,
      cacheFailure: projection.cacheFailure,
      onCreate: companionSurface.create,
      onSubmit: companionSurface.submit,
      onCancel: companionSurface.cancel,
      onLoadOlder: companionSurface.loadOlder,
      onObserveSession: companionSurface.observeSession,
      onAttach: companionSurface.attach,
      onSearch: companionSurface.search,
      onClearCache: companionSurface.clearProjectionCache.bind(companionSurface),
    }
  return (
    <MobileAccount
      installation={composition.installation}
      {...(composition.pairing === undefined ? {} : { pairing: composition.pairing })}
      companion={authenticated}
      locale={locale}
      theme={theme}
      clock={clock}
    />
  )
}
