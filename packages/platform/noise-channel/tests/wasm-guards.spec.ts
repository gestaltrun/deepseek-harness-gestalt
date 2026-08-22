import { beforeEach, describe, expect, it, vi } from 'vitest'

const snow = vi.hoisted(() => ({
  generateKeypair: vi.fn(() => Uint8Array.of(1)),
  initiatorMessage3: vi.fn(() => new Uint8Array(32)),
  responderFinish: vi.fn(() => new Uint8Array(63)),
}))

vi.mock('@deepseek-ai/dsh-noise-channel/snow-wasm', () => ({
  default: vi.fn(async () => undefined),
  initSync: vi.fn(),
  generate_keypair: snow.generateKeypair,
  xkpsk3_initiator_msg1: vi.fn(),
  xkpsk3_initiator_msg3: snow.initiatorMessage3,
  xkpsk3_initiator_open: vi.fn(),
  xkpsk3_responder_finish: snow.responderFinish,
  xkpsk3_responder_msg2: vi.fn(),
  xkpsk3_responder_seal: vi.fn(),
  IkInitiator: class { readonly mocked = true },
  IkResponder: class { readonly mocked = true },
}))

describe('Snow WASM result validation', () => {
  beforeEach(() => { vi.resetModules() })

  it('rejects invalid keypair, initiator finish, and responder finish lengths', async () => {
    const wasm = await import('../src/wasm.ts')
    await expect(wasm.generateSnowKeypair()).rejects.toThrow('keypair must contain 64 bytes')
    await expect(wasm.writePairingMessage3({
      mobileStaticPrivate: new Uint8Array(32),
      mobileEphemeralPrivate: new Uint8Array(32),
      desktopPublic: new Uint8Array(32),
      psk: new Uint8Array(32),
      message2: Uint8Array.of(1),
    })).rejects.toThrow('Mobile finish is truncated')
    await expect(wasm.finishPairingResponder({
      desktopStaticPrivate: new Uint8Array(32),
      desktopEphemeralPrivate: new Uint8Array(32),
      psk: new Uint8Array(32),
      message1: Uint8Array.of(1),
      message3: Uint8Array.of(2),
    })).rejects.toThrow('Desktop finish must contain two 32-byte values')
    wasm.initializeSnowChannel(new Uint8Array())
  })
})
