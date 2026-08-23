/* tslint:disable */
/* eslint-disable */

/**
 * Mobile-owned IK handshake state with a fresh Snow-generated ephemeral.
 */
export class IkInitiator {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Read IK message 2 and enter transport mode.
     */
    finish(message2: Uint8Array): NoiseTransport;
    /**
     * Write IK message 1 exactly once.
     */
    message1(): Uint8Array;
    /**
     * Create one attachment-bound IK initiator.
     */
    constructor(mobile_static_private: Uint8Array, desktop_public: Uint8Array, prologue: Uint8Array);
}

/**
 * Desktop-owned IK responder for one physical Relay attachment.
 */
export class IkResponder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Read message 1, authenticate the expected Mobile static, and write message 2.
     */
    accept(message1: Uint8Array): Uint8Array;
    /**
     * Enter transport mode after message 2 was emitted.
     */
    finish(): NoiseTransport;
    /**
     * Create one attachment-bound IK responder.
     */
    constructor(desktop_static_private: Uint8Array, expected_mobile_public: Uint8Array, prologue: Uint8Array);
}

/**
 * One stateful Snow transport owned by one physical Relay attachment.
 */
export class NoiseTransport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Open one ordered Companion ciphertext.
     */
    open(ciphertext: Uint8Array): Uint8Array;
    /**
     * Seal one ordered Companion plaintext.
     */
    seal(plaintext: Uint8Array): Uint8Array;
}

/**
 * Generate one X25519 keypair as `private || public`.
 */
export function generate_keypair(): Uint8Array;

/**
 * Write XKpsk3 initiator message 1.
 */
export function xkpsk3_initiator_msg1(mobile_static_private: Uint8Array, mobile_ephemeral_private: Uint8Array, desktop_public: Uint8Array, psk: Uint8Array): Uint8Array;

/**
 * Read XKpsk3 message 2 and write initiator message 3 plus finished handshake hash.
 */
export function xkpsk3_initiator_msg3(mobile_static_private: Uint8Array, mobile_ephemeral_private: Uint8Array, desktop_public: Uint8Array, psk: Uint8Array, message2: Uint8Array): Uint8Array;

/**
 * Rebuild the finished XKpsk3 initiator and open the first responder transport payload.
 */
export function xkpsk3_initiator_open(mobile_static_private: Uint8Array, mobile_ephemeral_private: Uint8Array, desktop_public: Uint8Array, psk: Uint8Array, message2: Uint8Array, ciphertext: Uint8Array): Uint8Array;

/**
 * Finish XKpsk3 and return `handshake hash || authenticated Mobile static public key`.
 */
export function xkpsk3_responder_finish(desktop_static_private: Uint8Array, desktop_ephemeral_private: Uint8Array, psk: Uint8Array, message1: Uint8Array, message3: Uint8Array): Uint8Array;

/**
 * Read XKpsk3 message 1 and write responder message 2.
 */
export function xkpsk3_responder_msg2(desktop_static_private: Uint8Array, desktop_ephemeral_private: Uint8Array, psk: Uint8Array, message1: Uint8Array): Uint8Array;

/**
 * Rebuild the finished XKpsk3 responder and seal the Mobile-only Relay grant as its first transport payload.
 */
export function xkpsk3_responder_seal(desktop_static_private: Uint8Array, desktop_ephemeral_private: Uint8Array, psk: Uint8Array, message1: Uint8Array, message3: Uint8Array, plaintext: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly generate_keypair: (a: number) => void;
    readonly xkpsk3_initiator_msg1: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly xkpsk3_responder_msg2: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly xkpsk3_initiator_msg3: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly xkpsk3_responder_finish: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly xkpsk3_responder_seal: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly xkpsk3_initiator_open: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly __wbg_noisetransport_free: (a: number, b: number) => void;
    readonly noisetransport_seal: (a: number, b: number, c: number, d: number) => void;
    readonly noisetransport_open: (a: number, b: number, c: number, d: number) => void;
    readonly __wbg_ikinitiator_free: (a: number, b: number) => void;
    readonly ikinitiator_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly ikinitiator_message1: (a: number, b: number) => void;
    readonly ikinitiator_finish: (a: number, b: number, c: number, d: number) => void;
    readonly __wbg_ikresponder_free: (a: number, b: number) => void;
    readonly ikresponder_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly ikresponder_accept: (a: number, b: number, c: number, d: number) => void;
    readonly ikresponder_finish: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export3: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
