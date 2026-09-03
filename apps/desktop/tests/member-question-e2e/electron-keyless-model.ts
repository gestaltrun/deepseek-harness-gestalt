/** Keyless model listener for the assembled Project Members Electron lane. */

import { createServer } from 'node:http'

/** Running keyless model listener. */
export interface KeylessModelProvider {
  readonly origin: string
  close(): Promise<void>
}

/**
 * Start the deterministic streaming model used by the keyless Electron regression.
 * @returns Running listener and its quiescent disposer.
 */
export async function startKeylessModelProvider(): Promise<KeylessModelProvider> {
  let remoteAccountId = 'account-b'
  const server = createServer((request, response) => {
    const chunks: Uint8Array[] = []
    request.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        accountId?: string
        messages?: Array<{ role?: string }>
        tools?: Array<{ function?: { name?: string } }>
      }
      if (request.url === '/control/member') {
        if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end('{"error":"accountId is required"}')
          return
        }
        remoteAccountId = body.accountId
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ accountId: remoteAccountId }))
        return
      }
      const toolResult = body.messages?.some(message => message.role === 'tool') === true
      const hasAsk = body.tools?.some(tool => tool.function?.name === 'ask_user_question') === true
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (hasAsk && !toolResult) {
        const args = JSON.stringify({
          questions: [{
            id: 'rollout',
            question: 'Approve the guarded rollout?',
            options: [{ label: 'approve' }, { label: 'revise' }],
          }],
          to_project_member: remoteAccountId,
          background: 'Review the Markdown, HTML, and plain-text materials before choosing the rollout.',
          references: [
            { path: 'decision.md', reason: 'Current decision' },
            { path: 'preview.html', reason: 'Restricted preview' },
            { path: 'notes.txt', reason: 'Plain notes' },
          ],
        })
        response.end([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
            index: 0,
            id: 'call-project-member',
            type: 'function',
            function: { name: 'ask_user_question', arguments: args },
          }] } }] })}`,
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
        return
      }
      response.end([
        'data: {"choices":[{"delta":{"content":"Project member accepted the guarded rollout."}}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('keyless model exposed no TCP address')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
