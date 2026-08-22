//! Thin Snow 0.10.0 adapter for Personal Pairing and per-attachment Companion channels.

use snow::{Builder, HandshakeState, TransportState, params::NoiseParams};
use wasm_bindgen::prelude::*;

const PAIRING_PROTOCOL: &str = "Noise_XKpsk3_25519_ChaChaPoly_SHA256";
const RECONNECT_PROTOCOL: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
const PAIRING_PROLOGUE: &[u8] = b"dsh-mobile-companion-pairing-v1";
const MAX_NOISE_MESSAGE_BYTES: usize = 65_535;
const MAX_TRANSPORT_PAYLOAD_BYTES: usize = MAX_NOISE_MESSAGE_BYTES - 16;
const KEY_BYTES: usize = 32;

type ChannelResult<T> = Result<T, JsError>;

fn params(protocol: &str) -> ChannelResult<NoiseParams> {
    protocol
        .parse()
        .map_err(|error| JsError::new(&format!("invalid Noise protocol: {error:?}")))
}

fn require_key(name: &str, value: &[u8]) -> ChannelResult<()> {
    if value.len() != KEY_BYTES {
        return Err(JsError::new(&format!("{name} must contain exactly {KEY_BYTES} bytes")));
    }
    Ok(())
}

fn psk32(psk: &[u8]) -> ChannelResult<[u8; KEY_BYTES]> {
    require_key("psk", psk)?;
    psk.try_into().map_err(|_| JsError::new("psk must contain exactly 32 bytes"))
}

/// Generate one X25519 keypair as `private || public`.
#[wasm_bindgen]
pub fn generate_keypair() -> ChannelResult<Vec<u8>> {
    let pair = Builder::new(params(PAIRING_PROTOCOL)?)
        .generate_keypair()
        .map_err(|error| JsError::new(&format!("generate keypair: {error:?}")))?;
    let mut out = Vec::with_capacity(KEY_BYTES * 2);
    out.extend_from_slice(&pair.private);
    out.extend_from_slice(&pair.public);
    Ok(out)
}

fn pairing_initiator(
    mobile_static_private: &[u8],
    mobile_ephemeral_private: &[u8],
    desktop_public: &[u8],
    psk: &[u8],
) -> ChannelResult<HandshakeState> {
    require_key("mobile static", mobile_static_private)?;
    require_key("mobile ephemeral", mobile_ephemeral_private)?;
    require_key("desktop public", desktop_public)?;
    let key = psk32(psk)?;
    Builder::new(params(PAIRING_PROTOCOL)?)
        .local_private_key(mobile_static_private)
        .map_err(|error| JsError::new(&format!("set mobile static: {error:?}")))?
        .remote_public_key(desktop_public)
        .map_err(|error| JsError::new(&format!("set desktop public: {error:?}")))?
        .fixed_ephemeral_key_for_testing_only(mobile_ephemeral_private)
        .prologue(PAIRING_PROLOGUE)
        .map_err(|error| JsError::new(&format!("set pairing initiator prologue: {error:?}")))?
        .psk(3, &key)
        .map_err(|error| JsError::new(&format!("set pairing initiator psk: {error:?}")))?
        .build_initiator()
        .map_err(|error| JsError::new(&format!("build pairing initiator: {error:?}")))
}

fn pairing_responder(
    desktop_static_private: &[u8],
    desktop_ephemeral_private: &[u8],
    psk: &[u8],
) -> ChannelResult<HandshakeState> {
    require_key("desktop static", desktop_static_private)?;
    require_key("desktop ephemeral", desktop_ephemeral_private)?;
    let key = psk32(psk)?;
    Builder::new(params(PAIRING_PROTOCOL)?)
        .local_private_key(desktop_static_private)
        .map_err(|error| JsError::new(&format!("set desktop static: {error:?}")))?
        .fixed_ephemeral_key_for_testing_only(desktop_ephemeral_private)
        .prologue(PAIRING_PROLOGUE)
        .map_err(|error| JsError::new(&format!("set pairing responder prologue: {error:?}")))?
        .psk(3, &key)
        .map_err(|error| JsError::new(&format!("set pairing responder psk: {error:?}")))?
        .build_responder()
        .map_err(|error| JsError::new(&format!("build pairing responder: {error:?}")))
}

fn write_empty(state: &mut HandshakeState) -> ChannelResult<Vec<u8>> {
    let mut message = vec![0_u8; MAX_NOISE_MESSAGE_BYTES];
    let length = state
        .write_message(&[], &mut message)
        .map_err(|error| JsError::new(&format!("handshake write: {error:?}")))?;
    Ok(message[..length].to_vec())
}

fn read_empty(state: &mut HandshakeState, message: &[u8]) -> ChannelResult<()> {
    let mut payload = vec![0_u8; MAX_NOISE_MESSAGE_BYTES];
    let length = state
        .read_message(message, &mut payload)
        .map_err(|error| JsError::new(&format!("handshake read: {error:?}")))?;
    if length != 0 {
        return Err(JsError::new("Noise handshake payload must be empty"));
    }
    Ok(())
}

/// Write XKpsk3 initiator message 1.
#[wasm_bindgen]
pub fn xkpsk3_initiator_msg1(
    mobile_static_private: &[u8],
    mobile_ephemeral_private: &[u8],
    desktop_public: &[u8],
    psk: &[u8],
) -> ChannelResult<Vec<u8>> {
    let mut state = pairing_initiator(
        mobile_static_private,
        mobile_ephemeral_private,
        desktop_public,
        psk,
    )?;
    write_empty(&mut state)
}

/// Read XKpsk3 message 1 and write responder message 2.
#[wasm_bindgen]
pub fn xkpsk3_responder_msg2(
    desktop_static_private: &[u8],
    desktop_ephemeral_private: &[u8],
    psk: &[u8],
    message1: &[u8],
) -> ChannelResult<Vec<u8>> {
    let mut state = pairing_responder(desktop_static_private, desktop_ephemeral_private, psk)?;
    read_empty(&mut state, message1)?;
    write_empty(&mut state)
}

/// Read XKpsk3 message 2 and write initiator message 3 plus finished handshake hash.
#[wasm_bindgen]
pub fn xkpsk3_initiator_msg3(
    mobile_static_private: &[u8],
    mobile_ephemeral_private: &[u8],
    desktop_public: &[u8],
    psk: &[u8],
    message2: &[u8],
) -> ChannelResult<Vec<u8>> {
    let mut state = pairing_initiator(
        mobile_static_private,
        mobile_ephemeral_private,
        desktop_public,
        psk,
    )?;
    let _message1 = write_empty(&mut state)?;
    read_empty(&mut state, message2)?;
    let message3 = write_empty(&mut state)?;
    if !state.is_handshake_finished() {
        return Err(JsError::new("pairing initiator did not finish after message 3"));
    }
    let mut out = Vec::with_capacity(message3.len() + KEY_BYTES);
    out.extend_from_slice(&message3);
    out.extend_from_slice(state.get_handshake_hash());
    Ok(out)
}

/// Finish XKpsk3 and return `handshake hash || authenticated Mobile static public key`.
#[wasm_bindgen]
pub fn xkpsk3_responder_finish(
    desktop_static_private: &[u8],
    desktop_ephemeral_private: &[u8],
    psk: &[u8],
    message1: &[u8],
    message3: &[u8],
) -> ChannelResult<Vec<u8>> {
    let mut state = pairing_responder(desktop_static_private, desktop_ephemeral_private, psk)?;
    read_empty(&mut state, message1)?;
    let _message2 = write_empty(&mut state)?;
    read_empty(&mut state, message3)?;
    if !state.is_handshake_finished() {
        return Err(JsError::new("pairing responder did not finish after message 3"));
    }
    let remote_static = state
        .get_remote_static()
        .ok_or_else(|| JsError::new("pairing responder authenticated no Mobile static key"))?;
    let mut out = Vec::with_capacity(KEY_BYTES * 2);
    out.extend_from_slice(state.get_handshake_hash());
    out.extend_from_slice(remote_static);
    Ok(out)
}

/// Rebuild the finished XKpsk3 responder and seal the Mobile-only Relay grant as its first transport payload.
#[wasm_bindgen]
pub fn xkpsk3_responder_seal(
    desktop_static_private: &[u8],
    desktop_ephemeral_private: &[u8],
    psk: &[u8],
    message1: &[u8],
    message3: &[u8],
    plaintext: &[u8],
) -> ChannelResult<Vec<u8>> {
    let mut state = pairing_responder(desktop_static_private, desktop_ephemeral_private, psk)?;
    read_empty(&mut state, message1)?;
    let _message2 = write_empty(&mut state)?;
    read_empty(&mut state, message3)?;
    let mut transport = state
        .into_transport_mode()
        .map_err(|error| JsError::new(&format!("split pairing responder transport: {error:?}")))?;
    transport_write(&mut transport, plaintext)
}

/// Rebuild the finished XKpsk3 initiator and open the first responder transport payload.
#[wasm_bindgen]
pub fn xkpsk3_initiator_open(
    mobile_static_private: &[u8],
    mobile_ephemeral_private: &[u8],
    desktop_public: &[u8],
    psk: &[u8],
    message2: &[u8],
    ciphertext: &[u8],
) -> ChannelResult<Vec<u8>> {
    let mut state = pairing_initiator(
        mobile_static_private,
        mobile_ephemeral_private,
        desktop_public,
        psk,
    )?;
    let _message1 = write_empty(&mut state)?;
    read_empty(&mut state, message2)?;
    let _message3 = write_empty(&mut state)?;
    let mut transport = state
        .into_transport_mode()
        .map_err(|error| JsError::new(&format!("split pairing initiator transport: {error:?}")))?;
    transport_read(&mut transport, ciphertext)
}

fn transport_write(state: &mut TransportState, plaintext: &[u8]) -> ChannelResult<Vec<u8>> {
    if plaintext.len() > MAX_TRANSPORT_PAYLOAD_BYTES {
        return Err(JsError::new("Companion plaintext exceeds the Noise transport ceiling"));
    }
    let mut ciphertext = vec![0_u8; plaintext.len() + 16];
    let length = state
        .write_message(plaintext, &mut ciphertext)
        .map_err(|error| JsError::new(&format!("transport write: {error:?}")))?;
    ciphertext.truncate(length);
    Ok(ciphertext)
}

fn transport_read(state: &mut TransportState, ciphertext: &[u8]) -> ChannelResult<Vec<u8>> {
    if ciphertext.len() > MAX_NOISE_MESSAGE_BYTES {
        return Err(JsError::new("Companion ciphertext exceeds the Noise message ceiling"));
    }
    let mut plaintext = vec![0_u8; ciphertext.len()];
    let length = state
        .read_message(ciphertext, &mut plaintext)
        .map_err(|error| JsError::new(&format!("transport read: {error:?}")))?;
    plaintext.truncate(length);
    Ok(plaintext)
}

/// One stateful Snow transport owned by one physical Relay attachment.
#[wasm_bindgen]
pub struct NoiseTransport {
    state: TransportState,
}

#[wasm_bindgen]
impl NoiseTransport {
    /// Seal one ordered Companion plaintext.
    pub fn seal(&mut self, plaintext: &[u8]) -> ChannelResult<Vec<u8>> {
        transport_write(&mut self.state, plaintext)
    }

    /// Open one ordered Companion ciphertext.
    pub fn open(&mut self, ciphertext: &[u8]) -> ChannelResult<Vec<u8>> {
        transport_read(&mut self.state, ciphertext)
    }
}

/// Mobile-owned IK handshake state with a fresh Snow-generated ephemeral.
#[wasm_bindgen]
pub struct IkInitiator {
    state: Option<HandshakeState>,
}

#[wasm_bindgen]
impl IkInitiator {
    /// Create one attachment-bound IK initiator.
    #[wasm_bindgen(constructor)]
    pub fn new(
        mobile_static_private: &[u8],
        desktop_public: &[u8],
        prologue: &[u8],
    ) -> ChannelResult<IkInitiator> {
        require_key("mobile static", mobile_static_private)?;
        require_key("desktop public", desktop_public)?;
        let state = Builder::new(params(RECONNECT_PROTOCOL)?)
            .local_private_key(mobile_static_private)
            .map_err(|error| JsError::new(&format!("set reconnect Mobile static: {error:?}")))?
            .remote_public_key(desktop_public)
            .map_err(|error| JsError::new(&format!("set reconnect Desktop public: {error:?}")))?
            .prologue(prologue)
            .map_err(|error| JsError::new(&format!("set reconnect prologue: {error:?}")))?
            .build_initiator()
            .map_err(|error| JsError::new(&format!("build reconnect initiator: {error:?}")))?;
        Ok(IkInitiator { state: Some(state) })
    }

    /// Write IK message 1 exactly once.
    pub fn message1(&mut self) -> ChannelResult<Vec<u8>> {
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| JsError::new("reconnect initiator is already finished"))?;
        if !state.is_my_turn() {
            return Err(JsError::new("reconnect initiator already wrote message 1"));
        }
        write_empty(state)
    }

    /// Read IK message 2 and enter transport mode.
    pub fn finish(&mut self, message2: &[u8]) -> ChannelResult<NoiseTransport> {
        let mut state = self
            .state
            .take()
            .ok_or_else(|| JsError::new("reconnect initiator is already finished"))?;
        read_empty(&mut state, message2)?;
        if !state.is_handshake_finished() {
            return Err(JsError::new("reconnect initiator did not finish after message 2"));
        }
        let transport = state
            .into_transport_mode()
            .map_err(|error| JsError::new(&format!("split reconnect initiator transport: {error:?}")))?;
        Ok(NoiseTransport { state: transport })
    }
}

/// Desktop-owned IK responder for one physical Relay attachment.
#[wasm_bindgen]
pub struct IkResponder {
    state: Option<HandshakeState>,
    expected_mobile_public: Vec<u8>,
}

#[wasm_bindgen]
impl IkResponder {
    /// Create one attachment-bound IK responder.
    #[wasm_bindgen(constructor)]
    pub fn new(
        desktop_static_private: &[u8],
        expected_mobile_public: &[u8],
        prologue: &[u8],
    ) -> ChannelResult<IkResponder> {
        require_key("desktop static", desktop_static_private)?;
        require_key("expected mobile public", expected_mobile_public)?;
        let state = Builder::new(params(RECONNECT_PROTOCOL)?)
            .local_private_key(desktop_static_private)
            .map_err(|error| JsError::new(&format!("set reconnect Desktop static: {error:?}")))?
            .prologue(prologue)
            .map_err(|error| JsError::new(&format!("set reconnect prologue: {error:?}")))?
            .build_responder()
            .map_err(|error| JsError::new(&format!("build reconnect responder: {error:?}")))?;
        Ok(IkResponder {
            state: Some(state),
            expected_mobile_public: expected_mobile_public.to_vec(),
        })
    }

    /// Read message 1, authenticate the expected Mobile static, and write message 2.
    pub fn accept(&mut self, message1: &[u8]) -> ChannelResult<Vec<u8>> {
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| JsError::new("reconnect responder is already finished"))?;
        read_empty(state, message1)?;
        if state.get_remote_static() != Some(self.expected_mobile_public.as_slice()) {
            return Err(JsError::new("reconnect authenticated a different Mobile pairing"));
        }
        let message2 = write_empty(state)?;
        if !state.is_handshake_finished() {
            return Err(JsError::new("reconnect responder did not finish after message 2"));
        }
        Ok(message2)
    }

    /// Enter transport mode after message 2 was emitted.
    pub fn finish(&mut self) -> ChannelResult<NoiseTransport> {
        let state = self
            .state
            .take()
            .ok_or_else(|| JsError::new("reconnect responder is already finished"))?;
        if !state.is_handshake_finished() {
            return Err(JsError::new("reconnect responder has not accepted message 1"));
        }
        let transport = state
            .into_transport_mode()
            .map_err(|error| JsError::new(&format!("split reconnect responder transport: {error:?}")))?;
        Ok(NoiseTransport { state: transport })
    }
}
