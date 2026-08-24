/**
 * REAL-composition proof: a test-only cordis.yml booted through the vendored
 * Loader mounts the blob store, pairing authority, and HTTP routes, and
 * disposing the HTTP fiber removes those routes.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import * as RemoteAttachments from '../src/index.ts'
import * as RemoteAttachmentsHttp from '../src/http.ts'

const STORE = '@deepseek-ai/dsh-remote-attachments'
const HTTP = '@deepseek-ai/dsh-remote-attachments/http'
const AUTHORITY = 'test-remote-attachment-authority'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Remote Attachments Loader composition', () => {
  it('keeps the HTTP function-plugin namespace free of a default export', () => {
    expect('default' in RemoteAttachmentsHttp).toBe(false)
    expect('default' in RemoteAttachments).toBe(false)
  })

  it('boots the store and HTTP routes from cordis.yml and removes them on fiber dispose', async () => {
    const loaded = await loadComposition()
    const origin = `http://127.0.0.1:${String(loaded.webServer.port)}`
    expect(loaded.remoteAttachments.maxBlobBytes).toBe(64)
    const upload = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-gestalt-pairing-id': 'pairing-a' },
      body: Uint8Array.of(1, 2, 3),
    })
    expect(upload.status).toBe(201)
    const httpEntry = [...loaded.loader.entries()].find(entry => entry.options.name === HTTP)
    if (httpEntry?.fiber === undefined) throw new Error('remote-attachments-http fiber was not mounted')
    await httpEntry.fiber.dispose()
    const after = await fetch(`${origin}/v1/remote-attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-gestalt-pairing-id': 'pairing-a' },
      body: Uint8Array.of(4, 5, 6),
    })
    expect(after.status).toBe(404)
  })
})

function testAuthority(): unknown {
  return {
    name: AUTHORITY,
    apply(ctx: Context) {
      ctx.provide('remoteAttachmentAuthority', {
        authenticate: async ({ headers }: { headers: { [key: string]: string | string[] | undefined } }) => {
          const value = headers['x-gestalt-pairing-id'] ?? headers['x-test-pairing']
          if (typeof value !== 'string') throw new Error('pairing header is required')
          return {
            pairingId: parsePersonalPairingId(value),
            admit: async () => ({
              id: 'loader-quota', expiresAt: Number.MAX_SAFE_INTEGER, release: async () => {},
            }),
          }
        },
      })
    },
  }
}

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-attachments-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `- name: '${STORE}'`,
    '  config:',
    '    maxBlobBytes: 64',
    '    maxRetainedBlobs: 4',
    '    sweepIntervalMs: 60000',
    `- name: '${AUTHORITY}'`,
    `- name: '${HTTP}'`,
    '  config:',
    "    origin: 'https://mobile.example'",
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    [STORE, RemoteAttachments],
    [AUTHORITY, testAuthority()],
    [HTTP, RemoteAttachmentsHttp],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}
