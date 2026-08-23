/** Shipped React composition for the Mobile application. */

import { StrictMode, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { MobileAccount } from './MobileAccount.tsx'
import type { MobilePairingActions } from './MobilePairing.tsx'
import type { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import {
  MobileCompanionSurface,
  type MobileCompanionMutationChannel,
} from './companion-surface.ts'

/** Product dependencies resolved before the Mobile React tree is mounted. */
export interface MobileEntryComposition {
  /** Current Mobile installation lifecycle controller. */
  installation: PlatformAccountInstallation
  /** Personal Pairing adapter available after sign-in. */
  pairing?: MobilePairingActions
  /** Current physical-connection synchronization authority. */
  companion: CompanionForegroundRuntime
  /** Reviewed encrypted channel that owns operations and decoded results. */
  companionChannel?: MobileCompanionMutationChannel
}

/** Mounted product entry and its authenticated Desktop projection receiver. */
interface MountedMobileEntry {
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
  const companionSurface = new MobileCompanionSurface(composition.companion, composition.companionChannel)
  const root = createRoot(container)
  root.render(
    <StrictMode>
      <MobileEntry composition={composition} companionSurface={companionSurface} />
    </StrictMode>,
  )
  return { companionSurface, unmount: () => { root.unmount() } }
}

function MobileEntry({
  composition,
  companionSurface,
}: {
  composition: MobileEntryComposition
  companionSurface: MobileCompanionSurface
}): ReactNode {
  const projection = useSyncExternalStore(
    listener => companionSurface.subscribe(listener),
    () => companionSurface.getSnapshot(),
  )
  return (
    <MobileAccount
      installation={composition.installation}
      {...(composition.pairing === undefined ? {} : { pairing: composition.pairing })}
      companionSurface={{
        ...(projection.desktopName === undefined ? {} : { desktopName: projection.desktopName }),
        sessions: projection.sessions,
        streaming: projection.streaming,
        attachment: projection.attachment,
        search: projection.search,
        onCreate: companionSurface.create,
        onSubmit: companionSurface.submit,
        onCancel: companionSurface.cancel,
        onAttach: companionSurface.attach,
        onSearch: companionSurface.search,
        onSettled: companionSurface.settle,
      }}
    />
  )
}
