import { createServer } from 'node:http'

/** Local OpenAI-compatible stream used only to seed real Desktop Session events in entry smokes. */
export interface KeylessDesktopProvider {
  /** Loopback provider origin for `DEEPSEEK_BASE_URL`. */
  readonly origin: string
  /** Stop the provider and all retained sockets. */
  close(): Promise<void>
}

/**
 * Start a deterministic loopback provider that completes title and conversation requests.
 * @returns running provider and its async disposer.
 */
export async function startKeylessDesktopProvider(): Promise<KeylessDesktopProvider> {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"desktop smoke response"}}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected provider TCP address')
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
