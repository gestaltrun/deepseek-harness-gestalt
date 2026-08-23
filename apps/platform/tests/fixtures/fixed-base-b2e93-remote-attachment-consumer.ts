/** Consume behavior built from fixed delivery base b2e93d3c835: inspect, write, then revoke. */

import type { ServerResponse } from 'node:http'
import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import type { RemoteAttachmentStoreService } from '@deepseek-ai/dsh-remote-attachments'
import type { AttachmentCapability } from '@deepseek-ai/dsh-remote-protocol'

/** Exact fixed-base commit represented by this compatibility artifact. */
export const FIXED_BASE_ATTACHMENT_CONSUMER_SHA = 'b2e93d3c835'

/**
 * Run the fixed-base non-atomic consume sequence over a real HTTP response.
 * @param input - fixed-base store, authority, response, and inspection synchronization.
 */
export async function runFixedBaseAttachmentConsume(input: {
  store: RemoteAttachmentStoreService
  pairingId: PersonalPairingId
  capability: AttachmentCapability
  response: ServerResponse
  now: number
  inspected(): Promise<void>
}): Promise<void> {
  const ciphertext = await input.store.inspect({
    pairingId: input.pairingId,
    capability: input.capability,
    now: input.now,
  })
  await input.inspected()
  await new Promise<void>((resolve, reject) => {
    input.response.once('error', reject)
    input.response.writeHead(200, { 'content-type': 'application/octet-stream' })
    input.response.end(ciphertext, resolve)
  })
  await input.store.revoke({ pairingId: input.pairingId, capability: input.capability })
}
