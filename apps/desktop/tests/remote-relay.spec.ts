import { describe, expect, it } from 'vitest'
import { createDesktopRemoteRelay } from '../src/remote-relay.ts'

describe('Desktop Remote Relay product gate', () => {
  it('keeps the product entry fail-closed until the reviewed channel is composed', async () => {
    const relay = createDesktopRemoteRelay()

    await expect(relay.start()).rejects.toThrow('independently reviewed')
    expect(relay.getState?.()).toEqual({ connected: false })
  })
})
