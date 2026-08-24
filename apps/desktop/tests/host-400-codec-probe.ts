import { createServer } from 'node:http'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  createCompanionNegotiationChannel,
  createCompanionVersionOffer,
  encodeCompanionMessage,
  negotiateCompanionProtocol,
  parseCompanionOperationId,
  REMOTE_PROTOCOL_LIMITS,
} from '@deepseek-ai/dsh-remote-protocol'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopCompanionProductOwner } from '../src/companion-product.ts'

/**
 * Produce the encoded Companion result emitted from one real HTTP 400 Host response.
 * @returns encoded result for the Mobile decoder probe.
 */
export async function runHost400CodecProbe(): Promise<Uint8Array> {
  const server = createServer((_request, response) => {
    response.writeHead(400).end('carrier rejected the request')
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected Host TCP address')
    const owner = new DesktopCompanionProductOwner({
      timeoutMs: 1_000,
      responseMaxBytes: REMOTE_PROTOCOL_LIMITS.companionMessageBytes,
    })
    owner.installHost(`http://127.0.0.1:${String(address.port)}`)
    const operationId = parseCompanionOperationId('visible-host-400')
    const result = await owner.handle({
      type: 'search-sessions', operationId, query: 'Host 400 visible alert',
    }, {
      pairingId: parsePersonalPairingId('visible-host-400-pairing'),
      attachmentKey: new Uint8Array(32),
      now: Date.now,
      downloadAttachment: () => Promise.reject(new Error('search must not download an attachment')),
      submitAttachment: () => Promise.reject(new Error('search must not submit an attachment')),
    })
    const protocol = negotiateCompanionProtocol(
      createCompanionNegotiationChannel(),
      createCompanionVersionOffer('mobile'),
      createCompanionVersionOffer('desktop'),
    )
    return encodeCompanionMessage(protocol, { type: 'result', result })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => { if (error === undefined) resolveClose(); else reject(error) })
    })
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  process.stdout.write(Buffer.from(await runHost400CodecProbe()).toString('base64'))
}
