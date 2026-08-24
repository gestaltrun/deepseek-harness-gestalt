/** Run the authenticated Desktop/Mobile transport flow over the keyless HTTP composition. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  parseAccountProofJti,
  selectPlatformEnvironment,
  validatePlatformEnvironmentPair,
} from '@deepseek-ai/dsh-platform-account'
import {
  PAIRING_CHALLENGE_TTL_MS,
  RemoteAccessError,
  deriveKeylessMobileHandshake,
  deriveKeylessPairingKey,
  parsePairingCompletionId,
  parsePairingInvitationLink,
  parsePairingRendezvousId,
  type PairingAccountAuthentication,
} from '@deepseek-ai/dsh-remote-access'
import { RemoteAccessHttpTransport } from '@deepseek-ai/dsh-remote-access-client'
import { keylessClock, keylessEvidence } from './src/provider.ts'

/** Cordis name for the keyless Personal Pairing acceptance runner. */
export const name = 'personal-pairing-keyless-scenario'
/** Runner dependencies assembled before the scenario executes. */
export const inject = ['remoteAccess', 'webServer']

/** Run one same-account pairing through the actual HTTP Consumer and shared transport. */
export async function apply(ctx: Context): Promise<void> {
  const localOrigin = `http://${ctx.webServer.host}:${String(ctx.webServer.port)}`
  const environment = selectPlatformEnvironment(validatePlatformEnvironmentPair({
    development: {
      environment: 'development', origin: 'https://platform.example.com',
      callbackUrl: 'https://platform.example.com/v1/account/oauth/github/callback',
      githubClientId: 'personal-pairing-keyless-development',
      credentialReference: 'credentials://personal-pairing-keyless-development',
      databaseIdentity: 'personal-pairing-keyless-development',
      identityNamespace: 'personal-pairing-keyless-development',
    },
    production: {
      environment: 'production', origin: 'https://platform.production.example.com',
      callbackUrl: 'https://platform.production.example.com/v1/account/oauth/github/callback',
      githubClientId: 'personal-pairing-keyless-production',
      credentialReference: 'credentials://personal-pairing-keyless-production',
      databaseIdentity: 'personal-pairing-keyless-production',
      identityNamespace: 'personal-pairing-keyless-production',
    },
  }), 'development')
  const transport = new RemoteAccessHttpTransport({
    environment,
    fetch: (input, init) => fetch(rewriteOrigin(input, localOrigin), init),
  })
  let proof = 0
  const authentication = (
    kind: 'desktop' | 'mobile',
    accountId = 'account-one',
    installationId = `${kind}-installation`,
  ): PairingAccountAuthentication => ({
    accessToken: `${accountId}:${kind}:${installationId}`,
    proof: {
      jti: parseAccountProofJti(`proof-${String(++proof)}`),
      issuedAt: Date.parse('2026-08-18T10:00:00.000Z'),
      signature: 'keyless-proof-signature',
    },
  })

  const desktop = () => authentication('desktop')
  const mobile = () => authentication('mobile', 'account-one', 'mobile-ios')
  console.log(`MOBILE_ACCESS default=${String((await transport.getMobileAccessState(desktop())).enabled)}`)
  await transport.setMobileAccess({ authentication: desktop(), enabled: true })

  const cross = await transport.createChallenge({
    authentication: desktop(),
    rendezvousId: parsePairingRendezvousId('rendezvous-cross'),
  })
  let crossAccount = 'unexpected'
  try {
    await transport.completeChallenge({
      authentication: authentication('mobile', 'account-two'),
      completionId: parsePairingCompletionId('completion-cross'),
      oneTimeLink: cross.oneTimeLink,
      mobileHandshake: Uint8Array.of(0),
    })
  } catch (error) {
    crossAccount = error instanceof RemoteAccessError ? error.code : 'unexpected'
  }
  console.log(`CROSS_ACCOUNT result=${crossAccount} principals=0`)

  const challenge = await transport.createChallenge({
    authentication: desktop(),
    rendezvousId: parsePairingRendezvousId('rendezvous-same'),
  })
  const invitation = parsePairingInvitationLink(challenge.oneTimeLink)
  const mobileHandshake = await deriveKeylessMobileHandshake(invitation.invitationSecret)
  const expectedKey = await deriveKeylessPairingKey(invitation.invitationSecret)
  invitation.invitationSecret.fill(0)
  const pending = await transport.completeChallenge({
    authentication: mobile(),
    completionId: parsePairingCompletionId('completion-same'),
    oneTimeLink: challenge.oneTimeLink,
    mobileHandshake,
  })
  const desktopPending = (await transport.listPendingPairings(desktop()))[0]
  console.log(`CHALLENGE ttlMs=${String(PAIRING_CHALLENGE_TTL_MS)} secretBits=256 qrEqualsLink=${String(challenge.qrPayload === challenge.oneTimeLink)}`)
  console.log(`AUTH_WORDS mobile=${pending.authenticationWords.join('-')} desktop=${desktopPending?.authenticationWords.join('-')}`)
  expectEqual(pending.desktopHandshake, expectedKey)
  await transport.confirmPairing({ authentication: desktop(), pendingPairingId: pending.pendingPairingId })
  const mobileStatus = await transport.getMobilePairingStatus({
    authentication: mobile(), pendingPairingId: pending.pendingPairingId,
  })
  const active = await transport.listPersonalPairings(desktop())
  console.log(`CONFIRM mobile=${mobileStatus.status} active=${String(active.length)} authority=${active[0]?.devicePrincipal.authority}`)
  console.log(`PAIRING_KEY bits=${String(expectedKey.byteLength * 8)} desktopEqualsMobile=${String(bytesEqual(pending.desktopHandshake, expectedKey))}`)

  const secondChallenge = await transport.createChallenge({
    authentication: desktop(),
    rendezvousId: parsePairingRendezvousId('rendezvous-second-mobile'),
  })
  const secondInvitation = parsePairingInvitationLink(secondChallenge.oneTimeLink)
  const secondHandshake = await deriveKeylessMobileHandshake(secondInvitation.invitationSecret)
  secondInvitation.invitationSecret.fill(0)
  const secondPending = await transport.completeChallenge({
    authentication: authentication('mobile', 'account-one', 'mobile-android'),
    completionId: parsePairingCompletionId('completion-second-mobile'),
    oneTimeLink: secondChallenge.oneTimeLink,
    mobileHandshake: secondHandshake,
  })
  const secondPairing = await transport.confirmPairing({
    authentication: desktop(),
    pendingPairingId: secondPending.pendingPairingId,
  })
  const twoPhones = await transport.listPersonalPairings(desktop())
  console.log(`DEVICES active=${String(twoPhones.length)} names=${twoPhones.map(pairing => pairing.device.name).join(',')} platforms=${twoPhones.map(pairing => pairing.device.platform).join(',')} principalsDistinct=${String(twoPhones[0]?.devicePrincipal.id !== twoPhones[1]?.devicePrincipal.id)}`)
  const firstPairing = active[0]
  if (firstPairing === undefined) throw new Error('confirmed Personal Pairing is missing')
  await transport.revokePersonalPairing({ authentication: desktop(), pairingId: firstPairing.id })
  const remaining = await transport.listPersonalPairings(desktop())
  console.log(`REVOKE remaining=${String(remaining.length)} name=${remaining[0]?.device.name} kept=${String(remaining[0]?.id === secondPairing.id)}`)

  const reused = await transport.createChallenge({
    authentication: desktop(),
    rendezvousId: parsePairingRendezvousId('rendezvous-reuse'),
  })
  const reusedInvitation = parsePairingInvitationLink(reused.oneTimeLink)
  const reusedHandshake = await deriveKeylessMobileHandshake(reusedInvitation.invitationSecret)
  reusedInvitation.invitationSecret.fill(0)
  await transport.completeChallenge({
    authentication: mobile(),
    completionId: parsePairingCompletionId('completion-reuse-first'),
    oneTimeLink: reused.oneTimeLink,
    mobileHandshake: reusedHandshake,
  })
  let singleUse = 'unexpected'
  try {
    await transport.completeChallenge({
      authentication: mobile(),
      completionId: parsePairingCompletionId('completion-reuse-second'),
      oneTimeLink: reused.oneTimeLink,
      mobileHandshake: reusedHandshake,
    })
  } catch (error) {
    singleUse = error instanceof RemoteAccessError ? error.code : 'unexpected'
  }
  console.log(`SINGLE_USE second=${singleUse}`)

  const expiring = await transport.createChallenge({
    authentication: desktop(),
    rendezvousId: parsePairingRendezvousId('rendezvous-expiry'),
  })
  keylessClock.now += PAIRING_CHALLENGE_TTL_MS - 1
  const liveInvitation = parsePairingInvitationLink(expiring.oneTimeLink)
  const liveHandshake = await deriveKeylessMobileHandshake(liveInvitation.invitationSecret)
  liveInvitation.invitationSecret.fill(0)
  const stillLive = await transport.completeChallenge({
    authentication: mobile(),
    completionId: parsePairingCompletionId('completion-live'),
    oneTimeLink: expiring.oneTimeLink,
    mobileHandshake: liveHandshake,
  })
  if (stillLive.device.platform !== 'ios') throw new Error('live completion is not the submitted Mobile device')
  console.log('EXPIRY beforeDeadline=true')

  const expired = await transport.createChallenge({
    authentication: desktop(),
    rendezvousId: parsePairingRendezvousId('rendezvous-expired'),
  })
  keylessClock.now += PAIRING_CHALLENGE_TTL_MS
  let expiry = 'unexpected'
  try {
    const expiredInvitation = parsePairingInvitationLink(expired.oneTimeLink)
    const expiredHandshake = await deriveKeylessMobileHandshake(expiredInvitation.invitationSecret)
    expiredInvitation.invitationSecret.fill(0)
    await transport.completeChallenge({
      authentication: mobile(),
      completionId: parsePairingCompletionId('completion-expired'),
      oneTimeLink: expired.oneTimeLink,
      mobileHandshake: expiredHandshake,
    })
  } catch (error) {
    expiry = error instanceof RemoteAccessError ? error.code : 'unexpected'
  }
  console.log(`EXPIRY atDeadline=${expiry}`)
  console.log(`CAPABILITY_DESTROYED challenge=${String(keylessEvidence.challenges)} pending=${String(keylessEvidence.pending)}`)
  console.log('FLOW transport=http consumer=ctx.remoteAccess')
  console.log('CRYPTO provider=keyless-proof reviewed=false')
}

function expectEqual(left: Uint8Array, right: Uint8Array): void {
  if (!bytesEqual(left, right)) throw new Error('Keyless Desktop handshake is not the derived pairing key')
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function rewriteOrigin(input: string | URL | Request, origin: string): string | URL | Request {
  if (input instanceof Request) return new Request(rewriteOrigin(input.url, origin), input)
  const url = new URL(String(input))
  const local = new URL(origin)
  url.protocol = local.protocol
  url.hostname = local.hostname
  url.port = local.port
  return input instanceof URL ? url : url.href
}
