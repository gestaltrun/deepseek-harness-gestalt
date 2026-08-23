import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  decodeCompanionMessage,
  decodeRelayMessage,
  encodeCompanionMessage,
  encodeRelayMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  parseCompanionSessionId,
  parseRelayAttachmentId,
  parseRelayRouteId,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'
import { KeylessHarnessCipher } from '../start.ts'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const config = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('Remote Protocol keyless assembled path', () => {
  it('boots the Loader and carries one encrypted Mobile operation to a Desktop-confirmed result', async () => {
    const result = await runLoaderSmoke({
      label: 'remote-protocol-keyless',
      tempDirPrefix: 'remote-protocol-keyless-',
      binScript: driver,
      libBinScript: driver,
      configPath: config,
      tsconfigPath: tsconfig,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatchInlineSnapshot(`
      "TRANSPORT version=1
      COMPANION version=3 security=preserved
      MOBILE_REQUEST encrypted=true relayPlaintext=false type=submit-prompt
      DESKTOP_RESPONSE confirmed=true outcome=accepted
      ATTACHMENT platformPlaintext=false hashVerified=true submitted=true controlFrameBytes=413 rejectionReason=hash-mismatch
      SESSION_SEARCH authority=desktop hits=1 hasMore=false
      HOST_FAILURE kind=http code=HOST_HTTP_STATUS status=400
      RECONNECT_QUERY operationId=operation-keyless committed=true original=accepted
      RECONNECT_QUERY operationId=operation-never-submitted committed=false notSubmitted=true
      NEGOTIATION mismatch=COMPANION_UPDATE_REQUIRED update=mobile applicationPlaintextSent=false
      "
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('carries the largest legal Companion message through harness AES-GCM and Relay framing', () => {
    const negotiated = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    const operation = {
      type: 'operation' as const,
      operation: {
        type: 'submit-prompt' as const,
        operationId: parseCompanionOperationId('operation-near-limit'),
        sessionId: parseCompanionSessionId('session-near-limit'),
        text: '',
      },
    }
    const emptyBytes = encodeCompanionMessage(negotiated, operation).byteLength
    expect(REMOTE_PROTOCOL_LIMITS.companionMessageBytes).toBe(60 * 1_024)
    expect(REMOTE_PROTOCOL_LIMITS.ciphertextBytes).toBe(65_535)
    operation.operation.text = 'x'.repeat(REMOTE_PROTOCOL_LIMITS.companionMessageBytes - emptyBytes)
    const plaintext = encodeCompanionMessage(negotiated, operation)
    expect(plaintext).toHaveLength(REMOTE_PROTOCOL_LIMITS.companionMessageBytes)

    const cipher = new KeylessHarnessCipher()
    const ciphertext = cipher.seal(plaintext)
    expect(ciphertext).toHaveLength(plaintext.byteLength + 12 + 16)
    expect(ciphertext.byteLength).toBeLessThanOrEqual(REMOTE_PROTOCOL_LIMITS.ciphertextBytes)
    const relayFrame = encodeRelayMessage({
      type: 'ciphertext',
      transportVersion: 1,
      routeId: parseRelayRouteId('route-near-limit'),
      sourceAttachmentId: parseRelayAttachmentId('mobile-near-limit'),
      targetAttachmentId: parseRelayAttachmentId('desktop-near-limit'),
      ciphertext,
    })
    expect(relayFrame.byteLength).toBeLessThanOrEqual(REMOTE_PROTOCOL_LIMITS.relayMessageBytes)
    const relayed = decodeRelayMessage(relayFrame)
    if (relayed.type !== 'ciphertext') throw new Error('Relay did not return ciphertext')
    expect(decodeCompanionMessage(negotiated, cipher.open(relayed.ciphertext))).toEqual(operation)
  })
})
