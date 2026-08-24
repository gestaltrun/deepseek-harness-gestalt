/** Fixed limits enforced by both Remote Protocol codecs. */
export const REMOTE_PROTOCOL_LIMITS = {
  /** Maximum nested object/array levels accepted after bounded JSON decoding. */
  parserDepth: 16,
  /** Maximum members in one encoded object or array. */
  containerValues: 256,
  /** Maximum primitive and container values in one encoded message. */
  totalEncodedValues: 4_096,
  /** Maximum UTF-8 bytes in one encoded string. */
  stringBytes: 90_000,
  /** Maximum complete Relay JSON frame bytes, including base64url overhead. */
  relayMessageBytes: 98_304,
  /** Maximum opaque Noise message bytes forwarded by one Relay frame. */
  ciphertextBytes: 65_535,
  /** Maximum Encrypted Companion application bytes before endpoint encryption. */
  companionMessageBytes: 60 * 1_024,
  /** Maximum complete encoded transcript-page message bytes. */
  transcriptPageBytes: 48 * 1_024,
  /** Maximum transcript entries in one approved Companion projection. */
  transcriptPageEntries: 50,
  /** Maximum UTF-8 bytes in one submitted prompt. */
  promptTextBytes: 60 * 1_024,
  /** Maximum message count requested in one Mobile history window. */
  historyPageMessages: 20,
  /** Maximum Session rows in one browse projection. */
  surfaceSessionRows: 20,
  /** Maximum Workspace rows in one browse projection. */
  surfaceWorkspaceRows: 20,
  /** Maximum distinct changed Sessions coalesced behind one slow Mobile projection consumer. */
  liveProjectionPendingSessions: 32,
  /** Maximum pending questions in one settlement. */
  interactionQuestions: 8,
  /** Maximum selected option labels in one question answer. */
  interactionSelections: 8,
  /** Maximum UTF-8 bytes in one interaction string. */
  interactionStringBytes: 4 * 1_024,
  /** Maximum decoded bytes in one historical image result chunk. */
  imageChunkBytes: 32 * 1_024,
  /** Maximum chunks in one historical image result. */
  imageChunks: 512,
  /** Maximum UTF-16 code units in one authoritative Session search query. */
  sessionSearchQueryCharacters: 500,
  /** Maximum Session/snippet pairs in one authoritative search result. */
  sessionSearchResults: 20,
  /** Maximum Unicode code points in one authoritative search snippet. */
  sessionSearchSnippetCodePoints: 240,
  /** Maximum UTF-8 bytes in one Host failure diagnostic displayed by Mobile. */
  hostFailureMessageBytes: 4 * 1_024,
  /** Maximum ciphertext bytes retained by the Platform for one Companion attachment blob. */
  attachmentBlobBytes: 100 * 1_024 * 1_024,
  /** Default lifetime of one Companion attachment capability and its retained blob. */
  attachmentCapabilityLifetimeMs: 15 * 60 * 1000,
  /** Maximum UTF-8 bytes in one Companion attachment file name. */
  attachmentFileNameBytes: 255,
  /** Maximum UTF-8 bytes in one Companion attachment media type. */
  attachmentMediaTypeBytes: 127,
} as const
