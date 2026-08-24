/** Development-only keyless Remote Access provider for the assembled transport example. */

import type { Context } from '@deepseek-ai/cordis'
import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  DevelopmentKeylessPairingHandshakeProvider,
  MemoryPersonalPairingAuthorityStore,
  PersonalPairingProvider,
  type PairingHandshakeProvider,
} from '@deepseek-ai/dsh-remote-access'

/** Cordis name for the keyless provider. */
export const name = 'personal-pairing-keyless-provider'

/** Observable destruction counts emitted by the example runner. */
export const keylessEvidence = { challenges: 0, pending: 0, active: 0 }

/** Mutable example clock so expiry can be advanced to the exact two-minute deadline. */
export const keylessClock = { now: Date.parse('2026-08-18T10:00:00.000Z') }

/** Assemble the single-process provider with the explicit unreviewed keyless adapter. */
export function apply(ctx: Context): void {
  const handshake = countedHandshake(new DevelopmentKeylessPairingHandshakeProvider())
  let id = 0
  let entropy = 0
  new PersonalPairingProvider(ctx, {
    account: {
      async currentInstallation({ accessToken }) {
        const [accountId, kind, installationId] = accessToken.split(':')
        if ((kind !== 'desktop' && kind !== 'mobile') || installationId === undefined || accountId === undefined) {
          throw new TypeError('Keyless Account token is invalid')
        }
        return {
          account: {
            id: parsePlatformAccountId(accountId),
            githubId: 1,
            githubLogin: accountId,
            avatarUrl: 'https://avatars.example/account',
          },
          installation: kind === 'mobile'
            ? {
              id: parseInstallationId(installationId),
              kind,
              presentation: {
                name: `${installationId} installation`,
                platform: installationId.includes('android') ? 'android' : 'ios',
              },
            }
            : { id: parseInstallationId(installationId), kind: 'desktop' as const, presentation: { name: 'Test Desktop', platform: 'linux' as const } },
        }
      },
    },
    handshake,
    authority: new MemoryPersonalPairingAuthorityStore(),
    clock: { now: () => keylessClock.now },
    randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index + entropy++),
    randomId: kind => `${kind}-${String(++id)}`,
    pairingLinkOrigin: 'https://platform.example.com/pair',
  })
}

function countedHandshake(inner: DevelopmentKeylessPairingHandshakeProvider): PairingHandshakeProvider {
  return {
    createChallenge: input => inner.createChallenge(input),
    completeChallenge: input => inner.completeChallenge(input),
    activatePairing: input => inner.activatePairing(input),
    sealMobileRelayAuthority: input => inner.sealMobileRelayAuthority(input),
    exportPairingKeyMaterial: key => inner.exportPairingKeyMaterial(key),
    destroyChallenge(state) {
      keylessEvidence.challenges += 1
      inner.destroyChallenge(state)
    },
    destroyPendingPairing(state) {
      keylessEvidence.pending += 1
      inner.destroyPendingPairing(state)
    },
    destroyPairing(state) {
      keylessEvidence.active += 1
      inner.destroyPairing(state)
    },
  }
}
