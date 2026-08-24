/** Load the committed Snow 0.10.0 WebAssembly module once per process. */

import init, {
  IkInitiator,
  IkResponder,
  generate_keypair,
  xkpsk3_initiator_msg1,
  xkpsk3_initiator_msg3,
  xkpsk3_initiator_open,
  xkpsk3_responder_finish,
  xkpsk3_responder_msg2,
  xkpsk3_responder_seal,
  type NoiseTransport,
  initSync,
} from '@deepseek-ai/dsh-noise-channel/snow-wasm'

let ready: Promise<void> | undefined

/**
 * Instantiate the committed Snow module before any channel call.
 * @returns settled after the module is live; later calls reuse the same instance.
 */
export async function ensureSnowChannel(): Promise<void> {
  ready ??= init({ module_or_path: packageSnowWasmUrl() }).then(() => undefined)
  await ready
}

/**
 * Initialize the same committed module from host-owned bytes.
 * Node callers use this before channel operations; browser callers use the package URL.
 * @param module - committed WASM bytes or a precompiled module.
 */
export function initializeSnowChannel(module: BufferSource | WebAssembly.Module): void {
  if (ready !== undefined) return
  initSync({ module })
  ready = Promise.resolve()
}

function packageSnowWasmUrl(): URL {
  return new URL('../pkg/dsh_noise_channel_bg.wasm', import.meta.url)
}

/** Generate one endpoint keypair.
 * @returns one Snow-generated X25519 keypair.
 */
export async function generateSnowKeypair(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  await ensureSnowChannel()
  const pair = generate_keypair()
  if (pair.byteLength !== 64) throw new TypeError('Snow keypair must contain 64 bytes')
  return { privateKey: pair.slice(0, 32), publicKey: pair.slice(32) }
}

/** Write first Mobile XKpsk3 message.
 * @param input - Mobile static/ephemeral private keys, Desktop public key, and invitation PSK.
 * @returns XKpsk3 message 1.
 */
export async function writePairingMessage1(input: {
  mobileStaticPrivate: Uint8Array
  mobileEphemeralPrivate: Uint8Array
  desktopPublic: Uint8Array
  psk: Uint8Array
}): Promise<Uint8Array> {
  await ensureSnowChannel()
  return xkpsk3_initiator_msg1(
    input.mobileStaticPrivate,
    input.mobileEphemeralPrivate,
    input.desktopPublic,
    input.psk,
  )
}

/** Read Mobile XKpsk3 message 1 and write Desktop message 2.
 * @param input - Desktop static/ephemeral private keys, invitation PSK, and message 1.
 * @returns XKpsk3 message 2.
 */
export async function writePairingMessage2(input: {
  desktopStaticPrivate: Uint8Array
  desktopEphemeralPrivate: Uint8Array
  psk: Uint8Array
  message1: Uint8Array
}): Promise<Uint8Array> {
  await ensureSnowChannel()
  return xkpsk3_responder_msg2(
    input.desktopStaticPrivate,
    input.desktopEphemeralPrivate,
    input.psk,
    input.message1,
  )
}

/** Read Desktop XKpsk3 message 2 and write Mobile message 3 plus the authentication hash.
 * @param input - Mobile static/ephemeral private keys, Desktop public key, PSK, and message 2.
 * @returns message 3 and public authentication hash.
 */
export async function writePairingMessage3(input: {
  mobileStaticPrivate: Uint8Array
  mobileEphemeralPrivate: Uint8Array
  desktopPublic: Uint8Array
  psk: Uint8Array
  message2: Uint8Array
}): Promise<{ message3: Uint8Array; handshakeHash: Uint8Array }> {
  await ensureSnowChannel()
  const packed = xkpsk3_initiator_msg3(
    input.mobileStaticPrivate,
    input.mobileEphemeralPrivate,
    input.desktopPublic,
    input.psk,
    input.message2,
  )
  return splitTail(packed, 32, 'XKpsk3 Mobile finish')
}

/** Finish Desktop XKpsk3 and return its hash plus the authenticated Mobile static public key.
 * @param input - Desktop private keys, invitation PSK, and initiator messages 1 and 3.
 * @returns authentication hash and authenticated Mobile public key.
 */
export async function finishPairingResponder(input: {
  desktopStaticPrivate: Uint8Array
  desktopEphemeralPrivate: Uint8Array
  psk: Uint8Array
  message1: Uint8Array
  message3: Uint8Array
}): Promise<{ handshakeHash: Uint8Array; mobilePublic: Uint8Array }> {
  await ensureSnowChannel()
  const packed = xkpsk3_responder_finish(
    input.desktopStaticPrivate,
    input.desktopEphemeralPrivate,
    input.psk,
    input.message1,
    input.message3,
  )
  if (packed.byteLength !== 64) throw new TypeError('XKpsk3 Desktop finish must contain two 32-byte values')
  return { handshakeHash: packed.slice(0, 32), mobilePublic: packed.slice(32) }
}

/** Seal the Relay grant as the first XKpsk3 responder transport payload.
 * @param input - completed responder handshake inputs and grant plaintext.
 * @returns first responder transport ciphertext.
 */
export async function sealPairingTransport(input: {
  desktopStaticPrivate: Uint8Array
  desktopEphemeralPrivate: Uint8Array
  psk: Uint8Array
  message1: Uint8Array
  message3: Uint8Array
  plaintext: Uint8Array
}): Promise<Uint8Array> {
  await ensureSnowChannel()
  return xkpsk3_responder_seal(
    input.desktopStaticPrivate,
    input.desktopEphemeralPrivate,
    input.psk,
    input.message1,
    input.message3,
    input.plaintext,
  )
}

/** Open the Relay grant from the first XKpsk3 responder transport payload.
 * @param input - completed initiator handshake inputs and grant ciphertext.
 * @returns opened grant plaintext.
 */
export async function openPairingTransport(input: {
  mobileStaticPrivate: Uint8Array
  mobileEphemeralPrivate: Uint8Array
  desktopPublic: Uint8Array
  psk: Uint8Array
  message2: Uint8Array
  ciphertext: Uint8Array
}): Promise<Uint8Array> {
  await ensureSnowChannel()
  return xkpsk3_initiator_open(
    input.mobileStaticPrivate,
    input.mobileEphemeralPrivate,
    input.desktopPublic,
    input.psk,
    input.message2,
    input.ciphertext,
  )
}

/** Start one Snow-generated IK initiator.
 * @param mobileStaticPrivate - Mobile static private key.
 * @param desktopPublic - authenticated Desktop static public key.
 * @param prologue - route-bound attachment transcript fields.
 * @returns stateful IK initiator.
 */
export async function createIkInitiator(
  mobileStaticPrivate: Uint8Array,
  desktopPublic: Uint8Array,
  prologue: Uint8Array,
): Promise<IkInitiator> {
  await ensureSnowChannel()
  return new IkInitiator(mobileStaticPrivate, desktopPublic, prologue)
}

/** Start one IK responder pinned to the Personal Pairing's Mobile static key.
 * @param desktopStaticPrivate - Desktop static private key.
 * @param mobilePublic - authenticated Mobile static public key.
 * @param prologue - route-bound attachment transcript fields.
 * @returns stateful IK responder.
 */
export async function createIkResponder(
  desktopStaticPrivate: Uint8Array,
  mobilePublic: Uint8Array,
  prologue: Uint8Array,
): Promise<IkResponder> {
  await ensureSnowChannel()
  return new IkResponder(desktopStaticPrivate, mobilePublic, prologue)
}

export type { IkInitiator, IkResponder, NoiseTransport }

function splitTail(value: Uint8Array, bytes: number, name: string): { message3: Uint8Array; handshakeHash: Uint8Array } {
  if (value.byteLength <= bytes) throw new TypeError(`${name} is truncated`)
  return {
    message3: value.slice(0, value.byteLength - bytes),
    handshakeHash: value.slice(value.byteLength - bytes),
  }
}
