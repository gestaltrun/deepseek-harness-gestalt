import { describe, expect, it } from 'vitest'
import { parseInstallationId, parsePlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import {
  EndpointOwnedPairingMailbox,
  parsePairingChallengeId,
  parsePairingCompletionId,
  parsePendingPairingId,
  parsePersonalPairingId,
} from '../src/index.ts'

const ACCOUNT = parsePlatformAccountId('account-one')
const OTHER_ACCOUNT = parsePlatformAccountId('account-two')
const DESKTOP = parseInstallationId('desktop-one')
const MOBILE = parseInstallationId('mobile-one')
const OTHER_DESKTOP = parseInstallationId('desktop-two')
const OTHER_MOBILE = parseInstallationId('mobile-two')
const CHALLENGE = parsePairingChallengeId('challenge-one')
const COMPLETION = parsePairingCompletionId('completion-one')
const PENDING = parsePendingPairingId('pending-one')
const PAIRING = parsePersonalPairingId('pairing-one')
const DEVICE = { name: 'Alice phone', platform: 'ios' as const }

describe('EndpointOwnedPairingMailbox', () => {
  it('forwards opaque XKpsk3 messages in order without retaining Desktop private state', () => {
    const mailbox = fixture()
    const desktopPrivateSentinel = Uint8Array.from({ length: 32 }, () => 213)
    mailbox.createChallenge({
      challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      expiresAt: 2_000,
    })
    expect(mailbox.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(11), now: 1_000,
    })).toEqual({ pendingPairingId: PENDING })
    expect(mailbox.readDesktop(PENDING, ACCOUNT, DESKTOP)).toMatchObject({
      stage: 'message1', message1: Uint8Array.of(11),
    })
    mailbox.submitMessage2({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      message2: Uint8Array.of(22),
    })
    expect(mailbox.readMobile(COMPLETION, ACCOUNT, MOBILE)).toMatchObject({
      stage: 'message2', message2: Uint8Array.of(22),
    })
    mailbox.submitMessage3({
      completionId: COMPLETION, accountId: ACCOUNT, mobileInstallationId: MOBILE,
      message3: Uint8Array.of(33),
    })
    expect(mailbox.readDesktop(PENDING, ACCOUNT, DESKTOP)).toMatchObject({
      stage: 'message3', message3: Uint8Array.of(33),
    })
    expect(JSON.stringify(mailbox.exportState())).not.toContain(JSON.stringify([...desktopPrivateSentinel]))
  })

  it('rejects wrong-account reads and message submission', () => {
    const mailbox = completedMessage1()
    expect(() => mailbox.readDesktop(PENDING, OTHER_ACCOUNT, DESKTOP)).toThrow('account')
    expect(() => mailbox.submitMessage2({
      pendingPairingId: PENDING, accountId: OTHER_ACCOUNT, desktopInstallationId: DESKTOP,
      message2: Uint8Array.of(22),
    })).toThrow('account')
    expect(() => mailbox.readMobile(COMPLETION, OTHER_ACCOUNT, MOBILE)).toThrow('account')
  })

  it('rejects expired challenges and a second completion identity', () => {
    const mailbox = fixture()
    mailbox.createChallenge({
      challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      expiresAt: 1_000,
    })
    expect(() => mailbox.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(11), now: 1_001,
    })).toThrow('expired')

    const active = completedMessage1()
    expect(() => active.submitMessage1({
      challengeId: CHALLENGE, completionId: parsePairingCompletionId('completion-other'),
      accountId: ACCOUNT, mobileInstallationId: MOBILE, device: DEVICE,
      message1: Uint8Array.of(11), now: 1_000,
    })).toThrow('used')
  })

  it('rejects message 3 and confirmation before their preceding mailbox stage', () => {
    const mailbox = completedMessage1()
    expect(() => mailbox.submitMessage3({
      completionId: COMPLETION, accountId: ACCOUNT, mobileInstallationId: MOBILE,
      message3: Uint8Array.of(33),
    })).toThrow('message 2')
    expect(() => { mailbox.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP, pairingId: PAIRING, now: 1_000,
    }) }).toThrow('message 3')
  })

  it('makes lost successful message responses idempotent and rejects a changed replay', () => {
    const mailbox = completedMessage1()
    const message2 = {
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      message2: Uint8Array.of(22),
    }
    expect(mailbox.submitMessage2(message2)).toEqual({ completionId: COMPLETION })
    expect(mailbox.submitMessage2(message2)).toEqual({ completionId: COMPLETION })
    expect(() => mailbox.submitMessage2({ ...message2, message2: Uint8Array.of(23) })).toThrow('stale')
    const message3 = {
      completionId: COMPLETION, accountId: ACCOUNT, mobileInstallationId: MOBILE,
      message3: Uint8Array.of(33),
    }
    expect(mailbox.submitMessage3(message3)).toEqual({ pendingPairingId: PENDING })
    expect(mailbox.submitMessage3(message3)).toEqual({ pendingPairingId: PENDING })
    expect(() => mailbox.submitMessage3({ ...message3, message3: Uint8Array.of(34) })).toThrow('stale')
  })

  it('delivers one sealed Relay authority only after Desktop confirmation', () => {
    const mailbox = completedMessage1()
    mailbox.submitMessage2({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      message2: Uint8Array.of(22),
    })
    mailbox.submitMessage3({
      completionId: COMPLETION, accountId: ACCOUNT, mobileInstallationId: MOBILE,
      message3: Uint8Array.of(33),
    })
    mailbox.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP, pairingId: PAIRING, now: 1_000,
    })
    const sealedRelayAuthority = Uint8Array.of(91, 92, 93)
    mailbox.deliverSealedAuthority({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      sealedRelayAuthority,
    })
    expect(mailbox.readMobile(COMPLETION, ACCOUNT, MOBILE)).toEqual({
      stage: 'confirmed', pendingPairingId: PENDING, pairingId: PAIRING, sealedRelayAuthority,
    })
  })

  it('cancels unused invitations and projects Desktop rejection to Mobile', () => {
    const cancelled = fixture()
    cancelled.createChallenge({
      challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      expiresAt: 2_000,
    })
    cancelled.cancelChallenge(CHALLENGE, ACCOUNT, DESKTOP)
    expect(() => cancelled.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(1), now: 1_000,
    })).toThrow('invalid')

    const rejected = completedMessage1()
    rejected.reject({ pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP, now: 1_500 })
    expect(rejected.readMobile(COMPLETION, ACCOUNT, MOBILE)).toEqual({
      stage: 'rejected', pendingPairingId: PENDING,
    })
    expect(rejected.exportState().pending[0]?.settledAt).toBe(1_500)
    expect(() => { rejected.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP, pairingId: PAIRING, now: 1_500,
    }) }).toThrow('message 3')
  })

  it('expires stale work across restart and sheds retained terminal records', () => {
    const mailbox = completedMessage1()
    const restarted = new EndpointOwnedPairingMailbox({
      pendingPairingId: () => parsePendingPairingId('unused'),
      state: mailbox.exportState(),
    })
    restarted.evict(2_001, 500)
    expect(restarted.readMobile(COMPLETION, ACCOUNT, MOBILE)).toEqual({
      stage: 'rejected', pendingPairingId: PENDING,
    })
    restarted.evict(2_502, 500)
    expect(() => restarted.readMobile(COMPLETION, ACCOUNT, MOBILE)).toThrow('invalid')
    expect(restarted.exportState()).toEqual({ challenges: [], pending: [] })
  })

  it('settles retained work when Desktop access is disabled', () => {
    const mailbox = completedMessage1()
    mailbox.disable(ACCOUNT, DESKTOP, 1_500)
    expect(mailbox.readMobile(COMPLETION, ACCOUNT, MOBILE)).toEqual({
      stage: 'rejected', pendingPairingId: PENDING,
    })
    expect(mailbox.exportState().challenges).toEqual([])

    const unrelated = completedMessage1()
    unrelated.createChallenge({
      challengeId: parsePairingChallengeId('challenge-unrelated'), accountId: ACCOUNT,
      desktopInstallationId: DESKTOP, expiresAt: 2_000,
    })
    unrelated.disable(OTHER_ACCOUNT, OTHER_DESKTOP, 1_600)
    expect(unrelated.exportState().pending).toHaveLength(1)
    expect(unrelated.exportState().challenges).toHaveLength(2)
  })

  it('rejects hostile restored collisions and invalid invitation metadata', () => {
    const challenge = {
      challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP, expiresAt: 2_000,
    }
    expect(() => new EndpointOwnedPairingMailbox({
      pendingPairingId: () => PENDING, state: { challenges: [challenge, challenge], pending: [] },
    })).toThrow('challenge state collided')
    const pending = completedMessage1().exportState().pending[0]
    if (pending === undefined) throw new Error('expected pending fixture')
    expect(() => new EndpointOwnedPairingMailbox({
      pendingPairingId: () => PENDING, state: { challenges: [], pending: [pending, pending] },
    })).toThrow('pending state collided')
    const mailbox = fixture()
    expect(() => { mailbox.createChallenge({ ...challenge, expiresAt: 0 }) }).toThrow('expiry must be positive')
    mailbox.createChallenge(challenge)
    expect(() => { mailbox.createChallenge(challenge) }).toThrow('already exists')
  })

  it('binds message replay, ids, accounts, and installations to one mailbox record', () => {
    const mailbox = completedMessage1()
    expect(mailbox.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(11), now: 1_000,
    })).toEqual({ pendingPairingId: PENDING })
    expect(() => mailbox.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(12), now: 1_000,
    })).toThrow('message 1 replay is stale')
    expect(() => mailbox.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: OTHER_MOBILE, device: DEVICE, message1: Uint8Array.of(11), now: 1_000,
    })).toThrow('Mobile installation')
    expect(() => mailbox.readDesktop(PENDING, ACCOUNT, OTHER_DESKTOP)).toThrow('Desktop installation')
    expect(() => mailbox.readMobile(COMPLETION, ACCOUNT, OTHER_MOBILE)).toThrow('Mobile installation')
    expect(() => mailbox.readDesktop(parsePendingPairingId('missing'), ACCOUNT, DESKTOP)).toThrow('pending identity')

    const wrongAccount = fixture()
    wrongAccount.createChallenge({
      challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP, expiresAt: 2_000,
    })
    expect(() => wrongAccount.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: OTHER_ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(1), now: 1_000,
    })).toThrow('challenge account')

    const collision = new EndpointOwnedPairingMailbox({ pendingPairingId: () => PENDING })
    collision.createChallenge({
      challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP, expiresAt: 2_000,
    })
    collision.submitMessage1({
      challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(1), now: 1_000,
    })
    const secondChallenge = parsePairingChallengeId('challenge-two')
    collision.createChallenge({
      challengeId: secondChallenge, accountId: ACCOUNT, desktopInstallationId: DESKTOP, expiresAt: 2_000,
    })
    expect(() => collision.submitMessage1({
      challengeId: secondChallenge, completionId: parsePairingCompletionId('completion-two'), accountId: ACCOUNT,
      mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(1), now: 1_000,
    })).toThrow('pending id collided')
  })

  it('projects every terminal stage and rejects stale terminal replays', () => {
    const mailbox = completedMessage1()
    expect(mailbox.readMobile(COMPLETION, ACCOUNT, MOBILE)).toEqual({
      stage: 'awaiting-desktop', pendingPairingId: PENDING,
    })
    mailbox.submitMessage2({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      message2: Uint8Array.of(22),
    })
    mailbox.submitMessage3({
      completionId: COMPLETION, accountId: ACCOUNT, mobileInstallationId: MOBILE,
      message3: Uint8Array.of(33),
    })
    expect(() => { mailbox.deliverSealedAuthority({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      sealedRelayAuthority: Uint8Array.of(1),
    }) }).toThrow('not confirmed')
    mailbox.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      pairingId: PAIRING, now: 1_000,
    })
    mailbox.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      pairingId: PAIRING, now: 1_001,
    })
    expect(() => { mailbox.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      pairingId: parsePersonalPairingId('pairing-two'), now: 1_001,
    }) }).toThrow('confirmation replay is stale')
    expect(mailbox.readDesktop(PENDING, ACCOUNT, DESKTOP)).toMatchObject({ stage: 'confirmed' })
    expect(mailbox.readMobile(COMPLETION, ACCOUNT, MOBILE)).toEqual({
      stage: 'awaiting-authority', pendingPairingId: PENDING,
    })
    expect(() => { mailbox.reject({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP, now: 1_002,
    }) }).toThrow('already confirmed')
    const sealed = Uint8Array.of(9)
    mailbox.deliverSealedAuthority({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      sealedRelayAuthority: sealed,
    })
    mailbox.deliverSealedAuthority({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      sealedRelayAuthority: sealed,
    })
    expect(() => { mailbox.deliverSealedAuthority({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      sealedRelayAuthority: Uint8Array.of(8),
    }) }).toThrow('authority replay is stale')
  })

  it('rejects unavailable cancellation and unbounded opaque messages', () => {
    const mailbox = completedMessage1()
    expect(() => { mailbox.cancelChallenge(CHALLENGE, ACCOUNT, DESKTOP) }).toThrow('unavailable')
    expect(() => { mailbox.cancelChallenge(parsePairingChallengeId('missing'), ACCOUNT, DESKTOP) }).toThrow('unavailable')
    for (const message1 of [new Uint8Array(), new Uint8Array(4_097)]) {
      expect(() => mailbox.submitMessage1({
        challengeId: CHALLENGE, completionId: parsePairingCompletionId('opaque'), accountId: ACCOUNT,
        mobileInstallationId: MOBILE, device: DEVICE, message1, now: 1_000,
      })).toThrow('must contain 1-4096 bytes')
    }
    expect(() => mailbox.submitMessage3({
      completionId: parsePairingCompletionId('missing'), accountId: ACCOUNT,
      mobileInstallationId: MOBILE, message3: Uint8Array.of(1),
    })).toThrow('completion is invalid')
  })

  it('rejects confirmation after a fully exchanged pairing is rejected', () => {
    const mailbox = completedMessage1()
    mailbox.submitMessage2({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      message2: Uint8Array.of(2),
    })
    mailbox.submitMessage3({
      completionId: COMPLETION, accountId: ACCOUNT, mobileInstallationId: MOBILE,
      message3: Uint8Array.of(3),
    })
    mailbox.reject({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP, now: 1_000,
    })
    expect(() => { mailbox.confirm({
      pendingPairingId: PENDING, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
      pairingId: PAIRING, now: 1_000,
    }) }).toThrow('was rejected')
  })
})

function fixture(): EndpointOwnedPairingMailbox {
  return new EndpointOwnedPairingMailbox({ pendingPairingId: () => PENDING })
}

function completedMessage1(): EndpointOwnedPairingMailbox {
  const mailbox = fixture()
  mailbox.createChallenge({
    challengeId: CHALLENGE, accountId: ACCOUNT, desktopInstallationId: DESKTOP,
    expiresAt: 2_000,
  })
  mailbox.submitMessage1({
    challengeId: CHALLENGE, completionId: COMPLETION, accountId: ACCOUNT,
    mobileInstallationId: MOBILE, device: DEVICE, message1: Uint8Array.of(11), now: 1_000,
  })
  return mailbox
}
