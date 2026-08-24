/** Bounded product Noise proof shared by Node and native WebViews. */

export { default as initShipped, initSync as initShippedSync } from '../pkg/dsh_noise_channel.js'
import {
  IkInitiator,
  IkResponder,
  generate_keypair,
  xkpsk3_initiator_msg1,
  xkpsk3_initiator_msg3,
  xkpsk3_initiator_open,
  xkpsk3_responder_finish,
  xkpsk3_responder_msg2,
  xkpsk3_responder_seal,
} from '../pkg/dsh_noise_channel.js'

/** @returns bounded pairing, transport, attack, and frame-limit results from the shipped package. */
export function runShippedImplementationProof() {
  const mobile = splitKeypair(generate_keypair())
  const desktop = splitKeypair(generate_keypair())
  const otherMobile = splitKeypair(generate_keypair())
  const mobileEphemeral = splitKeypair(generate_keypair()).privateKey
  const desktopEphemeral = splitKeypair(generate_keypair()).privateKey
  const psk = new Uint8Array(32).fill(7)
  const message1 = xkpsk3_initiator_msg1(mobile.privateKey, mobileEphemeral, desktop.publicKey, psk)
  const message2 = xkpsk3_responder_msg2(desktop.privateKey, desktopEphemeral, psk, message1)
  const message3AndHash = xkpsk3_initiator_msg3(mobile.privateKey, mobileEphemeral, desktop.publicKey, psk, message2)
  const message3 = message3AndHash.slice(0, -32)
  const initiatorHash = message3AndHash.slice(-32)
  const responderResult = xkpsk3_responder_finish(desktop.privateKey, desktopEphemeral, psk, message1, message3)
  const responderHash = responderResult.slice(0, 32)
  const authenticatedMobile = responderResult.slice(32)
  const grant = new TextEncoder().encode('sealed-mobile-relay-authority')
  const sealed = xkpsk3_responder_seal(desktop.privateKey, desktopEphemeral, psk, message1, message3, grant)
  const opened = xkpsk3_initiator_open(mobile.privateKey, mobileEphemeral, desktop.publicKey, psk, message2, sealed)

  const prologue = new TextEncoder().encode('attachment:route:mobile:desktop:generation')
  const ik = reconnect(mobile, desktop, prologue)
  const forward = new TextEncoder().encode('mobile-to-desktop')
  const backward = new TextEncoder().encode('desktop-to-mobile')
  const forwardCiphertext = ik.mobile.seal(forward)
  const forwardPlaintext = ik.desktop.open(forwardCiphertext)
  const backwardPlaintext = ik.mobile.open(ik.desktop.seal(backward))
  ik.mobile.free()
  ik.desktop.free()

  const first = new IkInitiator(mobile.privateKey, desktop.publicKey, prologue)
  const second = new IkInitiator(mobile.privateKey, desktop.publicKey, prologue)
  const firstMessage = first.message1()
  const secondMessage = second.message1()
  first.free()
  second.free()

  const tamper = reconnect(mobile, desktop, prologue)
  const tampered = tamper.mobile.seal(Uint8Array.of(1, 2, 3))
  tampered[tampered.length - 1] ^= 1
  const tamperRejected = rejects(() => tamper.desktop.open(tampered))
  tamper.mobile.free()
  tamper.desktop.free()

  const replay = reconnect(mobile, desktop, prologue)
  const replayed = replay.mobile.seal(Uint8Array.of(4))
  replay.desktop.open(replayed)
  const replayRejected = rejects(() => replay.desktop.open(replayed))
  replay.mobile.free()
  replay.desktop.free()

  const ordered = reconnect(mobile, desktop, prologue)
  ordered.mobile.seal(Uint8Array.of(1))
  const secondCiphertext = ordered.mobile.seal(Uint8Array.of(2))
  const orderingRejected = rejects(() => ordered.desktop.open(secondCiphertext))
  ordered.mobile.free()
  ordered.desktop.free()

  const wrongResponder = new IkResponder(desktop.privateKey, otherMobile.publicKey, prologue)
  const wrongInitiator = new IkInitiator(mobile.privateKey, desktop.publicKey, prologue)
  const crossPairingRejected = rejects(() => wrongResponder.accept(wrongInitiator.message1()))
  wrongResponder.free()
  wrongInitiator.free()

  const maximum = reconnect(mobile, desktop, prologue)
  const maximumPlaintext = new Uint8Array(65_519).fill(3)
  const maximumRoundTrip = equal(maximum.desktop.open(maximum.mobile.seal(maximumPlaintext)), maximumPlaintext)
  const oversizeRejected = rejects(() => maximum.mobile.seal(new Uint8Array(65_520)))
  maximum.mobile.free()
  maximum.desktop.free()

  return {
    pairingXkpsk3: equal(initiatorHash, responderHash)
      && equal(authenticatedMobile, mobile.publicKey) && equal(opened, grant),
    reconnectIk: equal(forwardPlaintext, forward) && equal(backwardPlaintext, backward),
    freshEphemeralKeys: !equal(firstMessage.slice(0, 32), secondMessage.slice(0, 32)),
    tamperRejected,
    replayRejected,
    orderingRejected,
    crossPairingRejected,
    maximumRoundTrip,
    oversizeRejected,
  }
}

function reconnect(mobile, desktop, prologue) {
  const initiator = new IkInitiator(mobile.privateKey, desktop.publicKey, prologue)
  const responder = new IkResponder(desktop.privateKey, mobile.publicKey, prologue)
  const message2 = responder.accept(initiator.message1())
  const mobileTransport = initiator.finish(message2)
  const desktopTransport = responder.finish()
  initiator.free()
  responder.free()
  return { mobile: mobileTransport, desktop: desktopTransport }
}

function splitKeypair(value) {
  if (value.byteLength !== 64) throw new Error('shipped Noise keypair length is invalid')
  return { privateKey: value.slice(0, 32), publicKey: value.slice(32) }
}

function equal(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function rejects(operation) {
  try { operation(); return false } catch { return true }
}
