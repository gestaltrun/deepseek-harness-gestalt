import { Context } from '@deepseek-ai/cordis'
import {
  parseRelayAttachmentId,
  parseRelayCredential,
  parseRelayRouteId,
  type RelayCiphertextMessage,
} from '@deepseek-ai/dsh-remote-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryPlatformCapacityGate,
  RemoteRelayError,
  parseRelayConnectionToken,
  parseRelayDeliveryId,
  parseRelayInstanceId,
  type RelayCoordinationEvent,
  type RelayCoordinator,
  type RelayDirectoryEntry,
  type RelayRouteStore,
  type RelayPairingActivitySink,
} from '../src/index.ts'
import { RemoteRelayProvider } from '../src/relay-provider.ts'

const CONFIG = {
  capacityRetryAfterMs: 1_000,
  deliveryAckTimeoutMs: 50,
  directoryTtlMs: 30_000,
  heartbeatTimeoutMs: 45_000,
  maxBufferedCiphertextBytes: 128 * 1024,
  maxConnections: 20,
  maxPendingDeliveries: 20,
} as const

afterEach(() => { vi.useRealTimers() })

describe('RemoteRelayProvider', () => {
  it('issues independent endpoint authority only while a route remains active', async () => {
    let entropy = 0
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-issue'),
      routeStore: new SharedRouteStore(),
      coordinator: new SharedCoordinator(),
      config: CONFIG,
      randomBytes: size => new Uint8Array(size).fill(++entropy),
    })
    const routeId = parseRelayRouteId('route-issue')
    const desktop = await platform.rotateCredential(routeId)
    const mobile = await platform.issueCredential(routeId)

    expect(mobile).toMatchObject({ routeId, revision: desktop.revision })
    expect(mobile.credential).not.toBe(desktop.credential)
    await platform.revokeRoute(routeId)
    await expect(platform.issueCredential(routeId)).rejects.toMatchObject({ code: 'RELAY_ROUTE_REVOKED' })
    await platform.revokeCredential(desktop)
    await platform.dispose()
  })

  it('revokes one endpoint credential and publishes an invalidate', async () => {
    const coordinator = new SharedCoordinator()
    const invalidate = vi.spyOn(coordinator, 'invalidate')
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-revoke-credential'),
      routeStore: new SharedRouteStore(),
      coordinator,
      config: CONFIG,
      randomBytes: size => new Uint8Array(size).fill(9),
    })
    const routeId = parseRelayRouteId('route-revoke-credential')
    await platform.rotateCredential(routeId, 'desktop')
    const mobile = await platform.issueCredential(routeId, 'mobile')
    await platform.revokeCredential(mobile)
    expect(invalidate).toHaveBeenCalledWith({
      type: 'invalidate',
      routeId,
      revision: mobile.revision + 1,
    })
    await platform.dispose()
  })

  it('projects authenticated Mobile attach, heartbeat, ciphertext access, and disconnect activity', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const recordRelayLease = vi.fn(async (
      _input: Parameters<RelayPairingActivitySink['recordRelayLease']>[0],
    ) => {})
    const releaseRelayLease = vi.fn(async (
      _input: Parameters<RelayPairingActivitySink['releaseRelayLease']>[0],
    ) => {})
    let now = 100
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-activity'),
      routeStore,
      coordinator,
      config: CONFIG,
      randomBytes: uniqueRandomBytes(31),
      clock: { now: () => now },
      pairingActivity: { recordRelayLease, releaseRelayLease },
    })
    const routeId = parseRelayRouteId('route-activity')
    const desktopGrant = await platform.rotateCredential(routeId, 'desktop')
    const mobileGrant = await platform.issueCredential(routeId, 'mobile')
    const desktopId = parseRelayAttachmentId('desktop-activity')
    const mobileId = parseRelayAttachmentId('mobile-activity')
    const desktop = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId, attachmentId: desktopId,
        endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => {},
    })
    const mobile = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId, attachmentId: mobileId,
        endpoint: 'mobile', credential: mobileGrant.credential,
      },
      deliver: async () => {},
    })
    expect(recordRelayLease).toHaveBeenLastCalledWith(expect.objectContaining({ accessedAt: 100, expiresAt: 30_100 }))

    now = 200
    await mobile.receive({ type: 'heartbeat', transportVersion: 1, attachmentId: mobileId, sentAt: now })
    expect(recordRelayLease).toHaveBeenLastCalledWith(expect.objectContaining({ accessedAt: 200, expiresAt: 30_200 }))

    now = 300
    await mobile.receive({
      type: 'ciphertext', transportVersion: 1, routeId,
      sourceAttachmentId: mobileId, targetAttachmentId: desktopId, ciphertext: Uint8Array.of(1),
    })
    expect(recordRelayLease).toHaveBeenLastCalledWith(expect.objectContaining({ accessedAt: 300 }))

    await mobile.close()
    expect(releaseRelayLease).toHaveBeenCalledWith({
      credentialFingerprint: recordRelayLease.mock.lastCall?.[0].credentialFingerprint,
      connectionToken: recordRelayLease.mock.lastCall?.[0].connectionToken,
      observedAt: 300,
    })
    await desktop.close()
    await platform.dispose()
  })

  it('does not publish a directory entry until announce flushes ready', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-announce', routeStore, coordinator, 4)
    const routeId = parseRelayRouteId('route-announce')
    const grant = await platform.rotateCredential(routeId, 'desktop')
    const attachmentId = parseRelayAttachmentId('desktop-announce')
    let locatedBeforeReady: Awaited<ReturnType<SharedCoordinator['locate']>> = undefined
    const attachment = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId, attachmentId, endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
      announce: async () => {
        locatedBeforeReady = await coordinator.locate(routeId, attachmentId)
      },
    })
    expect(locatedBeforeReady).toBeUndefined()
    expect(await coordinator.locate(routeId, attachmentId)).toMatchObject({ attachmentId })
    await attachment.close()
    await platform.dispose()
  })

  it('rejects cross-endpoint credentials in both directions', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 3)
    const routeId = parseRelayRouteId('route-endpoint-scope')
    const desktop = await platform.rotateCredential(routeId, 'desktop')
    const mobile = await platform.issueCredential(routeId, 'mobile')
    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-wrong'), endpoint: 'desktop', credential: mobile.credential,
      }, deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-wrong'), endpoint: 'mobile', credential: desktop.credential,
      }, deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    await platform.dispose()
  })

  it('does not retain invalidation history for routes with no local attach work', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 7)
    for (let index = 0; index < 1_000; index += 1) {
      await coordinator.invalidate({
        type: 'invalidate', routeId: parseRelayRouteId(`reclaimed-${String(index)}`), revision: 1,
      })
    }
    const routeId = parseRelayRouteId('route-after-reclamation')
    const grant = await platform.rotateCredential(routeId)
    const attachment = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-after-reclamation'), endpoint: 'desktop',
        credential: grant.credential,
      },
      deliver: async () => {},
    })
    await attachment.close()
    await platform.dispose()
  })

  it('retains failed cleanup as a capacity-owning tombstone and retries only unfinished work', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-a'), routeStore, coordinator,
      config: { ...CONFIG, maxConnections: 1 }, randomBytes: uniqueRandomBytes(9),
    })
    const routeId = parseRelayRouteId('route-cleanup-tombstone')
    const grant = await platform.rotateCredential(routeId)
    const closeSocket = vi.fn()
    const first = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-tombstone'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {}, close: closeSocket,
    })
    coordinator.failUnregister = true
    await expect(first.close()).rejects.toThrow('Relay attachment drain failed')
    expect(closeSocket).toHaveBeenCalledOnce()
    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-blocked'), endpoint: 'desktop', credential: grant.credential,
      }, deliver: async () => {},
    })).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY' })
    coordinator.failUnregister = false
    await first.close()
    expect(closeSocket).toHaveBeenCalledOnce()
    const replacement = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-replacement'), endpoint: 'desktop', credential: grant.credential,
      }, deliver: async () => {},
    })
    await replacement.close()
    await platform.dispose()
  })

  it.each(['authorize', 'register'] as const)('cancels in-flight $stage work and reaches provider quiescence', async (stage) => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 10)
    const routeId = parseRelayRouteId(`route-cancel-${stage}`)
    const grant = await platform.rotateCredential(routeId)
    const entered = deferred<undefined>()
    if (stage === 'authorize') {
      routeStore.authorize = vi.fn(async (
        _routeId: string,
        _endpoint: 'desktop' | 'mobile',
        _digest: Uint8Array,
        signal?: AbortSignal,
      ) => {
        entered.resolve(undefined)
        await aborted(signal)
        throw new Error('authority cancelled')
      })
    } else {
      coordinator.register = vi.fn(async (_entry: RelayDirectoryEntry, signal?: AbortSignal) => {
        entered.resolve(undefined)
        await aborted(signal)
        throw new Error('registration cancelled')
      })
    }
    const controller = new AbortController()
    const attaching = platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId(`desktop-cancel-${stage}`), endpoint: 'desktop', credential: grant.credential,
      }, deliver: async () => {}, signal: controller.signal,
    })
    await entered.promise
    controller.abort()
    await expect(attaching).rejects.toBeDefined()
    await expect(platform.dispose()).resolves.toBeUndefined()
  })

  it('rejects a pre-aborted attach before acquiring shared resources', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-pre-aborted', routeStore, coordinator, 12)
    const routeId = parseRelayRouteId('route-pre-aborted')
    const grant = await platform.rotateCredential(routeId)
    const controller = new AbortController()
    controller.abort()

    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-pre-aborted'), endpoint: 'desktop', credential: grant.credential,
      }, deliver: async () => {}, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    expect(await coordinator.locate(routeId, parseRelayAttachmentId('desktop-pre-aborted'))).toBeUndefined()
    await platform.dispose()
  })

  it('shares one in-flight disposal transaction across concurrent callers', async () => {
    const stopped = deferred<undefined>()
    const coordinator = new SharedCoordinator()
    const listen = vi.fn(async () => async () => { await stopped.promise })
    coordinator.listen = listen
    const platform = provider('platform-concurrent-dispose', new SharedRouteStore(), coordinator, 15)

    const first = platform.dispose()
    const second = platform.dispose()
    await Promise.resolve()
    stopped.resolve(undefined)

    await Promise.all([first, second])
    expect(listen).toHaveBeenCalledOnce()
  })

  it('retries a concurrent delivery-id collision without overwriting the first acknowledgement', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const collision = parseRelayDeliveryId('delivery-collision')
    const next = parseRelayDeliveryId('delivery-next')
    const deliveryId = vi.fn<() => ReturnType<typeof parseRelayDeliveryId>>()
      .mockReturnValueOnce(collision).mockReturnValueOnce(collision).mockReturnValueOnce(next)
    const platformA = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-a'), routeStore, coordinator,
      config: { ...CONFIG, deliveryAckTimeoutMs: 1_000 }, deliveryId,
    })
    const platformB = provider('platform-b', routeStore, coordinator, 13)
    const routeId = parseRelayRouteId('route-delivery-collision')
    const grant = await platformA.rotateCredential(routeId, 'mobile')
    const desktopGrant = await platformA.issueCredential(routeId, 'desktop')
    const release = deferred<undefined>()
    const mobile = await platformA.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-collision'), endpoint: 'mobile', credential: grant.credential,
      }, deliver: async () => {},
    })
    await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-collision'), endpoint: 'desktop', credential: desktopGrant.credential,
      }, deliver: async () => { await release.promise },
    })
    const first = mobile.receive(ciphertext(routeId, 'mobile-collision', 'desktop-collision', Uint8Array.of(1)))
    void first.catch(() => {})
    await vi.waitFor(() => { expect(deliveryId).toHaveBeenCalledOnce() })
    const second = mobile.receive(ciphertext(routeId, 'mobile-collision', 'desktop-collision', Uint8Array.of(2)))
    void second.catch(() => {})
    await vi.waitFor(() => { expect(deliveryId).toHaveBeenCalledTimes(3) })
    release.resolve(undefined)
    await Promise.all([first, second])
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('fails loud when bounded delivery-id collision retries are exhausted', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const collision = parseRelayDeliveryId('delivery-exhausted')
    const source = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-collision-source'), routeStore, coordinator,
      config: { ...CONFIG, deliveryAckTimeoutMs: 1_000 }, deliveryId: () => collision,
    })
    const target = provider('platform-collision-target', routeStore, coordinator, 14)
    const routeId = parseRelayRouteId('route-collision-exhausted')
    const grant = await source.rotateCredential(routeId, 'mobile')
    const desktopGrant = await source.issueCredential(routeId, 'desktop')
    const release = deferred<undefined>()
    const mobile = await source.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-collision-exhausted'), endpoint: 'mobile',
        credential: grant.credential,
      }, deliver: async () => {},
    })
    await target.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-collision-exhausted'), endpoint: 'desktop',
        credential: desktopGrant.credential,
      }, deliver: async () => { await release.promise },
    })
    const first = mobile.receive(ciphertext(
      routeId, 'mobile-collision-exhausted', 'desktop-collision-exhausted', Uint8Array.of(1),
    ))
    void first.catch(() => {})
    await vi.waitFor(() => { expect(coordinator.events).toContainEqual(expect.objectContaining({ type: 'ciphertext' })) })

    await expect(mobile.receive(ciphertext(
      routeId, 'mobile-collision-exhausted', 'desktop-collision-exhausted', Uint8Array.of(2),
    ))).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY' })
    release.resolve(undefined)
    await first
    await Promise.all([source.dispose(), target.dispose()])
  })

  it('forwards bounded ciphertext when Mobile and Desktop attach to different instances', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platformA = provider('platform-a', routeStore, coordinator, 11)
    const platformB = provider('platform-b', routeStore, coordinator, 29)
    const routeId = parseRelayRouteId('route-one')
    const grant = await platformA.rotateCredential(routeId, 'mobile')
    const desktopGrant = await platformA.issueCredential(routeId, 'desktop')
    const mobileFrames: RelayCiphertextMessage[] = []
    const desktopFrames: RelayCiphertextMessage[] = []
    const mobile = await platformA.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async (message) => { mobileFrames.push(message) },
    })
    await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async (message) => { desktopFrames.push(message) },
    })
    const ciphertext = Uint8Array.of(5, 8, 13, 21)

    await mobile.receive({
      type: 'ciphertext', transportVersion: 1, routeId,
      sourceAttachmentId: parseRelayAttachmentId('mobile-one'),
      targetAttachmentId: parseRelayAttachmentId('desktop-one'),
      ciphertext,
    })

    expect(mobileFrames).toEqual([])
    expect(desktopFrames).toEqual([expect.objectContaining({ ciphertext })])
    expect(coordinator.events).toEqual([
      expect.objectContaining({ type: 'ciphertext', routeId, ciphertext }),
      expect.objectContaining({ type: 'delivered' }),
    ])
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('rejects a route id without the current high-entropy credential', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 7)
    const routeId = parseRelayRouteId('route-one')
    await platform.rotateCredential(routeId)

    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop',
        credential: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as never,
      },
      deliver: async () => {},
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'RELAY_ATTACHMENT_REJECTED' }))
    await platform.dispose()
  })

  it('returns REMOTE_OFFLINE for a missing target without creating an offline queue', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 17)
    const routeId = parseRelayRouteId('route-one')
    const grant = await platform.rotateCredential(routeId, 'mobile')
    const mobile = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })

    await expect(mobile.receive({
      type: 'ciphertext', transportVersion: 1, routeId,
      sourceAttachmentId: parseRelayAttachmentId('mobile-one'),
      targetAttachmentId: parseRelayAttachmentId('desktop-missing'),
      ciphertext: Uint8Array.of(1),
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    expect(coordinator.events).toEqual([])
    expect(coordinator.queuedEventCount).toBe(0)
    await platform.dispose()
  })

  it('disconnects a slow consumer instead of buffering beyond the configured ciphertext limit', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platformA = provider('platform-a', routeStore, coordinator, 31)
    const platformB = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-b'),
      routeStore,
      coordinator,
      config: { ...CONFIG, maxBufferedCiphertextBytes: 4 },
      randomBytes: uniqueRandomBytes(37),
    })
    const routeId = parseRelayRouteId('route-slow')
    const grant = await platformA.rotateCredential(routeId, 'mobile')
    const desktopGrant = await platformA.issueCredential(routeId, 'desktop')
    const writer = deferred<undefined>()
    const mobile = await platformA.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })
    const desktop = await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => { await writer.promise },
    })
    const first = mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(1, 2, 3, 4)))
      .then(() => undefined, (error: unknown) => error as RemoteRelayError)
    await Promise.resolve()

    await expect(mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(5))))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    await expect(desktop.receive(ciphertext(routeId, 'desktop-one', 'mobile-one', Uint8Array.of(6))))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    writer.resolve(undefined)
    expect(await first).toMatchObject({ code: 'REMOTE_OFFLINE' })
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('rotates and revokes route authority across instances without interrupting unrelated routes', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    let randomByte = 40
    const platformA = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-a'), routeStore, coordinator, config: CONFIG,
      randomBytes: size => new Uint8Array(size).fill(++randomByte),
    })
    const platformB = provider('platform-b', routeStore, coordinator, 51)
    const routeId = parseRelayRouteId('route-rotated')
    const unrelatedRouteId = parseRelayRouteId('route-unrelated')
    const first = await platformA.rotateCredential(routeId)
    const unrelated = await platformA.rotateCredential(unrelatedRouteId)
    const oldDesktop = await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-old'), endpoint: 'desktop', credential: first.credential,
      },
      deliver: async () => {},
    })
    const unrelatedDesktop = await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId: unrelatedRouteId,
        attachmentId: parseRelayAttachmentId('desktop-unrelated'), endpoint: 'desktop', credential: unrelated.credential,
      },
      deliver: async () => {},
    })

    const rotated = await platformA.rotateCredential(routeId)
    expect(rotated.credential).not.toBe(first.credential)
    await expect(oldDesktop.receive(ciphertext(routeId, 'desktop-old', 'mobile-one', Uint8Array.of(1))))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    await expect(platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-rejected'), endpoint: 'desktop', credential: first.credential,
      },
      deliver: async () => {},
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'RELAY_ATTACHMENT_REJECTED' }))
    const currentDesktop = await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-current'), endpoint: 'desktop', credential: rotated.credential,
      },
      deliver: async () => {},
    })

    await platformA.revokeRoute(routeId)
    await expect(currentDesktop.receive(ciphertext(routeId, 'desktop-current', 'mobile-one', Uint8Array.of(2))))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    await expect(unrelatedDesktop.receive(ciphertext(
      unrelatedRouteId, 'desktop-unrelated', 'mobile-missing', Uint8Array.of(3),
    ))).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('sheds only new attachments at capacity and reports retry timing', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-a'), routeStore, coordinator,
      config: { ...CONFIG, maxConnections: 1 },
      randomBytes: uniqueRandomBytes(61),
    })
    const routeId = parseRelayRouteId('route-capacity')
    const grant = await platform.rotateCredential(routeId)
    const established = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-established'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })

    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-new'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({
      code: 'PLATFORM_CAPACITY', retryAfterMs: CONFIG.capacityRetryAfterMs,
    }))
    await expect(established.receive(ciphertext(
      routeId, 'desktop-established', 'mobile-missing', Uint8Array.of(1),
    ))).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    await platform.dispose()
  })

  it('reserves capacity before concurrent attachment authorization completes', async () => {
    const authorization = deferred<number | undefined>()
    const routeStore = new SharedRouteStore()
    const authorize = vi.spyOn(routeStore, 'authorize').mockImplementation(async () => await authorization.promise)
    const coordinator = new SharedCoordinator()
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-reservation'), routeStore, coordinator,
      config: { ...CONFIG, maxConnections: 1 },
      randomBytes: uniqueRandomBytes(63),
    })
    const credential = parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const first = platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId: parseRelayRouteId('route-capacity'),
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential,
      },
      deliver: async () => {},
    })
    await vi.waitFor(() => { expect(authorize).toHaveBeenCalledOnce() })

    const second = platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId: parseRelayRouteId('route-capacity'),
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential,
      },
      deliver: async () => {},
    })
    await Promise.resolve()
    expect(authorize).toHaveBeenCalledOnce()

    authorization.resolve(1)
    await first
    await expect(second).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY' })
    await platform.dispose()
  })

  it('quiesces an attachment registration before stopping coordination during disposal', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const register = coordinator.register.bind(coordinator)
    vi.spyOn(coordinator, 'register').mockImplementation(async (entry) => {
      entered.resolve(undefined)
      await release.promise
      await register(entry)
    })
    const stopped = vi.fn()
    const listen = coordinator.listen.bind(coordinator)
    vi.spyOn(coordinator, 'listen').mockImplementation(async (instanceId, listener) => {
      const stop = await listen(instanceId, listener)
      return async () => { stopped(); await stop() }
    })
    const platform = provider('platform-quiescence', routeStore, coordinator, 65)
    const routeId = parseRelayRouteId('route-quiescence')
    const grant = await platform.rotateCredential(routeId)
    const attaching = platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    await entered.promise
    const disposing = platform.dispose()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(stopped).not.toHaveBeenCalled()

    release.resolve(undefined)
    await expect(attaching).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await disposing
    expect(stopped).toHaveBeenCalledOnce()
    expect(await coordinator.locate(routeId, parseRelayAttachmentId('desktop-one'))).toBeUndefined()
  })

  it('reports coordination startup failure during disposal without acquiring attachments', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    coordinator.failListen = true
    const platform = provider('platform-listen-failure', routeStore, coordinator, 66)

    await expect(platform.dispose()).rejects.toThrow('Remote Relay disposal failed')
  })

  it('rejects an old authorization that is invalidated before attachment registration', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    let randomByte = 70
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-authorization-race'),
      routeStore,
      coordinator,
      config: CONFIG,
      randomBytes: size => new Uint8Array(size).fill(++randomByte),
    })
    const routeId = parseRelayRouteId('route-authorization-race')
    const firstGrant = await platform.rotateCredential(routeId)
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const authorize = routeStore.authorize.bind(routeStore)
    vi.spyOn(routeStore, 'authorize').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return firstGrant.revision
    }).mockImplementation(authorize)
    const attaching = platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: firstGrant.credential,
      },
      deliver: async () => {},
    })
    await entered.promise

    await platform.rotateCredential(routeId)
    release.resolve(undefined)

    await expect(attaching).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    expect(await coordinator.locate(routeId, parseRelayAttachmentId('desktop-one'))).toBeUndefined()
    await platform.dispose()
  })

  it('removes a registered attachment when authority changes during post-register revalidation', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-post-register-race', routeStore, coordinator, 71)
    const routeId = parseRelayRouteId('route-post-register-race')
    const grant = await platform.rotateCredential(routeId)
    const authorize = routeStore.authorize.bind(routeStore)
    let calls = 0
    vi.spyOn(routeStore, 'authorize').mockImplementation(async (id, endpoint, digest) => {
      calls += 1
      if (calls === 2) return grant.revision + 1
      return await authorize(id, endpoint, digest)
    })

    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    expect(await coordinator.locate(routeId, parseRelayAttachmentId('desktop-one'))).toBeUndefined()
    await platform.dispose()
  })

  it('requires a target delivery acknowledgement after asynchronous publication', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platformA = provider('platform-ack-source', routeStore, coordinator, 72)
    const platformB = provider('platform-ack-target', routeStore, coordinator, 74)
    const routeId = parseRelayRouteId('route-stale-ack')
    const grant = await platformA.rotateCredential(routeId, 'mobile')
    const mobile = await platformA.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })
    coordinator.put({
      routeId,
      attachmentId: parseRelayAttachmentId('desktop-stale'),
      endpoint: 'desktop',
      instanceId: parseRelayInstanceId('platform-ack-target'),
      connectionToken: parseRelayConnectionToken('stale-connection'),
      revision: grant.revision,
      expiresAt: Date.now() + 10_000,
    })

    await expect(mobile.receive(ciphertext(
      routeId, 'mobile-one', 'desktop-stale', Uint8Array.of(1),
    ))).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    expect(coordinator.events).toContainEqual(expect.objectContaining({ type: 'ciphertext' }))
    expect(coordinator.events).not.toContainEqual(expect.objectContaining({ type: 'delivered' }))
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('bounds pending delivery acknowledgements and validates delivery correlation entropy', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    let sourceIssued = 0
    const source = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-pending-source'), routeStore, coordinator,
      config: { ...CONFIG, maxPendingDeliveries: 1 },
      randomBytes: (size) => {
        sourceIssued += 1
        return uniqueBytes(size, 72 + sourceIssued * 101)
      },
    })
    const target = provider('platform-pending-target', routeStore, coordinator, 73)
    const routeId = parseRelayRouteId('route-pending-capacity')
    const grant = await source.rotateCredential(routeId, 'mobile')
    const desktopGrant = await source.issueCredential(routeId, 'desktop')
    const mobile = await source.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })
    const writer = deferred<undefined>()
    await target.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => { await writer.promise },
    })
    const first = mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(1)))
    await vi.waitFor(() => { expect(coordinator.events).toContainEqual(expect.objectContaining({ type: 'ciphertext' })) })
    await expect(mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(2))))
      .rejects.toMatchObject({ code: 'PLATFORM_CAPACITY' })
    const disposingSource = source.dispose()
    writer.resolve(undefined)
    await expect(first).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await Promise.all([disposingSource, target.dispose()])

    let entropyCalls = 0
    const badCoordinator = new SharedCoordinator()
    const badDelivery = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-bad-delivery'), routeStore: new SharedRouteStore(),
      coordinator: badCoordinator, config: CONFIG,
      randomBytes: size => new Uint8Array(++entropyCalls === 3 ? 15 : size).fill(74),
    })
    const badRoute = parseRelayRouteId('route-bad-delivery')
    const badGrant = await badDelivery.rotateCredential(badRoute, 'mobile')
    const badMobile = await badDelivery.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId: badRoute,
        attachmentId: parseRelayAttachmentId('mobile-bad'), endpoint: 'mobile', credential: badGrant.credential,
      },
      deliver: async () => {},
    })
    await badCoordinator.register({
      routeId: badRoute, attachmentId: parseRelayAttachmentId('desktop-bad'), endpoint: 'desktop',
      instanceId: parseRelayInstanceId('platform-missing'), connectionToken: parseRelayConnectionToken('token-bad'),
      revision: badGrant.revision, expiresAt: Date.now() + 1_000,
    })
    await expect(badMobile.receive(ciphertext(badRoute, 'mobile-bad', 'desktop-bad', Uint8Array.of(1))))
      .rejects.toThrow('delivery-id source must return 16 bytes')
    await badDelivery.dispose()
  })

  it('fails closed and detaches on heartbeat when shared route authority is uncertain', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 71)
    const routeId = parseRelayRouteId('route-heartbeat')
    const grant = await platform.rotateCredential(routeId)
    const desktop = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    routeStore.uncertain = true

    await expect(desktop.receive({
      type: 'heartbeat', transportVersion: 1,
      attachmentId: parseRelayAttachmentId('desktop-one'), sentAt: 1_787_027_200_000,
    } as never)).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'RELAY_ROUTE_REVOKED' }))
    await expect(desktop.receive(ciphertext(routeId, 'desktop-one', 'mobile-one', Uint8Array.of(1))))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    await platform.dispose()
  })

  it('expires an attachment that stops heartbeating and removes its shared-directory presence', async () => {
    vi.useFakeTimers()
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 73)
    const routeId = parseRelayRouteId('route-timeout')
    const grant = await platform.rotateCredential(routeId)
    const desktop = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })

    await vi.advanceTimersByTimeAsync(CONFIG.heartbeatTimeoutMs)

    await expect(desktop.receive(ciphertext(routeId, 'desktop-one', 'mobile-one', Uint8Array.of(1))))
      .rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({ code: 'REMOTE_OFFLINE' }))
    expect(await coordinator.locate(routeId, parseRelayAttachmentId('desktop-one'))).toBeUndefined()
    await platform.dispose()
  })

  it('observes every attachment and subscription failure during all-settled shutdown', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    coordinator.failUnregister = true
    coordinator.failStop = true
    const platform = provider('platform-a', routeStore, coordinator, 79)
    const routeId = parseRelayRouteId('route-shutdown')
    const grant = await platform.rotateCredential(routeId, 'mobile')
    const desktopGrant = await platform.issueCredential(routeId, 'desktop')
    const closeCalls: string[] = []
    let failClose = true
    for (const attachmentId of ['mobile-one', 'desktop-one'] as const) {
      await platform.attach({
        message: {
          type: 'attach', transportVersion: 1, routeId,
          attachmentId: parseRelayAttachmentId(attachmentId),
          endpoint: attachmentId.startsWith('mobile') ? 'mobile' : 'desktop',
          credential: attachmentId.startsWith('mobile') ? grant.credential : desktopGrant.credential,
        },
        deliver: async () => {},
        close: async () => {
          closeCalls.push(attachmentId)
          if (failClose) throw new Error(`${attachmentId} close failed`)
        },
      })
    }

    await expect(platform.dispose()).rejects.toMatchObject({
      errors: [expect.any(AggregateError), expect.any(AggregateError), expect.objectContaining({ message: 'stop failed' })],
    })
    expect(closeCalls).toEqual(['mobile-one', 'desktop-one'])
    expect(coordinator.unregisterCalls).toBe(2)
    coordinator.failUnregister = false
    coordinator.failStop = false
    failClose = false
    await expect(platform.dispose()).resolves.toBeUndefined()
    expect(closeCalls).toEqual(['mobile-one', 'desktop-one', 'mobile-one', 'desktop-one'])
    expect(coordinator.unregisterCalls).toBe(4)
  })

  it('does not finish shutdown before an in-flight socket writer reaches quiescence', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 83)
    const routeId = parseRelayRouteId('route-drain')
    const grant = await platform.rotateCredential(routeId, 'mobile')
    const desktopGrant = await platform.issueCredential(routeId, 'desktop')
    const writer = deferred<undefined>()
    const mobile = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })
    await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => { await writer.promise },
    })
    const forwarding = mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(1)))
      .then(() => undefined, (error: unknown) => error as RemoteRelayError)
    await Promise.resolve()
    let disposed = false
    const disposal = platform.dispose().then(() => { disposed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    expect(disposed).toBe(false)
    writer.resolve(undefined)
    expect(await forwarding).toMatchObject({ code: 'REMOTE_OFFLINE' })
    await disposal
    expect(disposed).toBe(true)
  })

  it('fails closed across malformed configuration, entropy, ids, storage, and registration', async () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new RemoteRelayProvider(new Context(), {
        instanceId: parseRelayInstanceId('platform-a'),
        routeStore: new SharedRouteStore(), coordinator: new SharedCoordinator(),
        config: { ...CONFIG, maxConnections: value },
      })).toThrow('must be a positive integer')
    }
    for (const value of [undefined, '', 'x'.repeat(129), 'not valid']) {
      expect(() => parseRelayInstanceId(value)).toThrow('Relay instance id')
      expect(() => parseRelayConnectionToken(value)).toThrow('Relay connection token')
      expect(() => parseRelayDeliveryId(value)).toThrow('Relay delivery id')
    }
    expect(parseRelayConnectionToken('connection_valid-1')).toBe('connection_valid-1')
    expect(parseRelayDeliveryId('delivery_valid-1')).toBe('delivery_valid-1')

    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const routeId = parseRelayRouteId('route-errors')
    const badCredentialEntropy = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-a'), routeStore, coordinator, config: CONFIG,
      randomBytes: () => new Uint8Array(31),
    })
    await expect(badCredentialEntropy.rotateCredential(routeId)).rejects.toThrow('must return 32 bytes')
    await badCredentialEntropy.dispose()

    let call = 0
    const badTokenEntropy = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-b'), routeStore, coordinator, config: CONFIG,
      randomBytes: size => new Uint8Array(call++ === 0 ? size : 15).fill(1),
    })
    const grant = await badTokenEntropy.rotateCredential(routeId)
    await expect(badTokenEntropy.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })).rejects.toThrow('must return 16 bytes')
    await badTokenEntropy.dispose()

    const defaults = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-defaults'),
      routeStore: new SharedRouteStore(), coordinator: new SharedCoordinator(), config: CONFIG,
    })
    await defaults.rotateCredential(parseRelayRouteId('route-defaults'))
    await defaults.dispose()
    await defaults.dispose()
    await expect(defaults.rotateCredential(routeId)).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await expect(defaults.revokeRoute(routeId)).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })

    routeStore.uncertain = true
    const unavailable = provider('platform-unavailable', routeStore, new SharedCoordinator(), 91)
    await expect(unavailable.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-two'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    await unavailable.dispose()

    routeStore.uncertain = false
    coordinator.failRegister = true
    const registration = provider('platform-registration', routeStore, coordinator, 93)
    await expect(registration.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-three'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })).rejects.toThrow('register failed')
    await registration.dispose()
  })

  it('rejects forged, stale, expired, and undeliverable live frames', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const clock = { value: 1_000 }
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-a'), routeStore, coordinator, config: CONFIG,
      randomBytes: uniqueRandomBytes(97), clock: { now: () => clock.value },
    })
    const routeId = parseRelayRouteId('route-forged')
    const grant = await platform.rotateCredential(routeId, 'mobile')
    const attachment = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })
    await expect(attachment.receive(ciphertext(
      parseRelayRouteId('route-other'), 'mobile-one', 'desktop-one', Uint8Array.of(1),
    ))).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    await expect(attachment.receive(ciphertext(
      routeId, 'mobile-other', 'desktop-one', Uint8Array.of(1),
    ))).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })

    coordinator.put({
      routeId, attachmentId: parseRelayAttachmentId('desktop-expired'), endpoint: 'desktop',
      instanceId: parseRelayInstanceId('platform-missing'), connectionToken: parseRelayConnectionToken('expired'),
      revision: grant.revision, expiresAt: 999,
    })
    await expect(attachment.receive(ciphertext(
      routeId, 'mobile-one', 'desktop-expired', Uint8Array.of(1),
    ))).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    coordinator.put({
      routeId, attachmentId: parseRelayAttachmentId('desktop-live'), endpoint: 'desktop',
      instanceId: parseRelayInstanceId('platform-missing'), connectionToken: parseRelayConnectionToken('live'),
      revision: grant.revision, expiresAt: 2_000,
    })
    await expect(attachment.receive(ciphertext(
      routeId, 'mobile-one', 'desktop-live', Uint8Array.of(1),
    ))).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await expect(attachment.receive({
      type: 'heartbeat', transportVersion: 1,
      attachmentId: parseRelayAttachmentId('mobile-other'), sentAt: 1,
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    await platform.dispose()
    await expect(attachment.receive(ciphertext(
      routeId, 'mobile-one', 'desktop-live', Uint8Array.of(1),
    ))).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await expect(attachment.receive({
      type: 'heartbeat', transportVersion: 1,
      attachmentId: parseRelayAttachmentId('mobile-one'), sentAt: 1,
    })).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
  })

  it('refreshes current heartbeats and closes on changed authority or stale directory ownership', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 101)
    const routeId = parseRelayRouteId('route-heartbeats')
    const grant = await platform.rotateCredential(routeId)
    const message = {
      type: 'attach' as const, transportVersion: 1 as const, routeId,
      attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop' as const,
      credential: grant.credential,
    }
    const current = await platform.attach({ message, deliver: async () => {} })
    await current.receive({
      type: 'heartbeat', transportVersion: 1, attachmentId: message.attachmentId, sentAt: 1,
    })
    expect(coordinator.refreshCalls).toBe(1)
    coordinator.failRefresh = true
    await expect(current.receive({
      type: 'heartbeat', transportVersion: 1, attachmentId: message.attachmentId, sentAt: 2,
    })).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })

    coordinator.failRefresh = false
    const changed = await platform.attach({ message, deliver: async () => {} })
    await platform.rotateCredential(routeId)
    await expect(changed.receive({
      type: 'heartbeat', transportVersion: 1, attachmentId: message.attachmentId, sentAt: 3,
    })).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await changed.close()
    await platform.dispose()
  })

  it('replaces duplicate attachments, ignores stale coordination, and closes failed writers', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platformA = provider('platform-a', routeStore, coordinator, 103)
    const platformB = provider('platform-b', routeStore, coordinator, 107)
    const routeId = parseRelayRouteId('route-events')
    const grant = await platformA.rotateCredential(routeId, 'desktop')
    const mobileGrant = await platformA.issueCredential(routeId, 'mobile')
    const close = vi.fn()
    const message = {
      type: 'attach' as const, transportVersion: 1 as const, routeId,
      attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop' as const,
      credential: grant.credential,
    }
    await platformB.attach({ message, deliver: async () => {}, close })
    const replacement = await platformB.attach({
      message,
      deliver: async () => { throw new Error('writer failed') },
    })
    expect(close).toHaveBeenCalledOnce()
    const mobile = await platformA.attach({
      message: {
        ...message, attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile',
        credential: mobileGrant.credential,
      },
      deliver: async () => {},
    })
    await coordinator.send(parseRelayInstanceId('platform-b'), {
      ...ciphertext(routeId, 'mobile-one', 'missing', Uint8Array.of(1)),
      sourceInstanceId: parseRelayInstanceId('platform-a'),
      targetConnectionToken: parseRelayConnectionToken('missing-token'), revision: grant.revision,
      deliveryId: parseRelayDeliveryId('delivery-missing'),
    })
    const current = await coordinator.locate(routeId, message.attachmentId)
    if (current === undefined) throw new Error('replacement directory entry missing')
    for (const event of [
      { token: parseRelayConnectionToken('stale-token'), revision: current.revision },
      { token: current.connectionToken, revision: current.revision + 1 },
    ]) {
      await coordinator.send(current.instanceId, {
        ...ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(2)),
        sourceInstanceId: parseRelayInstanceId('platform-a'),
        targetConnectionToken: event.token, revision: event.revision,
        deliveryId: parseRelayDeliveryId(`delivery-${String(event.revision)}`),
      })
    }
    await expect(mobile.receive(ciphertext(
      routeId, 'mobile-one', 'desktop-one', Uint8Array.of(3),
    ))).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
    await replacement.close()
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('rejects silently changed route authority on the next heartbeat', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 109)
    const routeId = parseRelayRouteId('route-silent-change')
    const grant = await platform.rotateCredential(routeId)
    const desktop = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    routeStore.advanceRevision(routeId)

    await expect(desktop.receive({
      type: 'heartbeat', transportVersion: 1,
      attachmentId: parseRelayAttachmentId('desktop-one'), sentAt: 1,
    })).rejects.toMatchObject({ code: 'RELAY_ROUTE_REVOKED' })
    await platform.dispose()
  })

  it('surfaces invalidation cleanup failures and keeps replacement attachment cleanup token-safe', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = provider('platform-a', routeStore, coordinator, 113)
    const routeId = parseRelayRouteId('route-invalidation-failure')
    const grant = await platform.rotateCredential(routeId)
    const first = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    const replacement = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    await first.close()
    expect(await coordinator.locate(routeId, parseRelayAttachmentId('desktop-one'))).toBeDefined()

    coordinator.failUnregister = true
    await expect(coordinator.invalidate({
      type: 'invalidate', routeId, revision: grant.revision + 1,
    })).rejects.toThrow('Relay invalidation cleanup failed')
    coordinator.failUnregister = false
    await expect(replacement.close()).resolves.toBeUndefined()
    await platform.dispose()
  })

  it('skips a queued delivery after its target closes and reports failed timeout cleanup', async () => {
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    let timeout: (() => void) | undefined
    const platformA = provider('platform-a', routeStore, coordinator, 127)
    const platformB = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-b'), routeStore, coordinator, config: CONFIG,
      randomBytes: uniqueRandomBytes(131),
      schedule: (task) => { timeout = task; return { unref: () => {} } as never },
    })
    const routeId = parseRelayRouteId('route-queued-close')
    const grant = await platformA.rotateCredential(routeId, 'mobile')
    const desktopGrant = await platformA.issueCredential(routeId, 'desktop')
    const writer = deferred<undefined>()
    let deliveries = 0
    const mobile = await platformA.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-one'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })
    const desktop = await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-one'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => { deliveries += 1; await writer.promise },
    })
    const first = mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(1)))
      .then(() => undefined, (error: unknown) => error as RemoteRelayError)
    await vi.waitFor(() => { expect(deliveries).toBe(1) })
    const second = mobile.receive(ciphertext(routeId, 'mobile-one', 'desktop-one', Uint8Array.of(2)))
      .then(() => undefined, (error: unknown) => error as RemoteRelayError)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const closing = desktop.close()
    writer.resolve(undefined)
    const [firstResult, secondResult] = await Promise.all([first, second, closing]).then(
      ([firstValue, secondValue]) => [firstValue, secondValue],
    )
    expect(firstResult).toMatchObject({ code: 'REMOTE_OFFLINE' })
    expect(secondResult).toMatchObject({ code: 'REMOTE_OFFLINE' })
    expect(deliveries).toBe(1)

    const timed = await platformB.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-timeout'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => {},
    })
    coordinator.failUnregister = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    timeout?.()
    await vi.waitFor(() => { expect(consoleError).toHaveBeenCalledOnce() })
    coordinator.failUnregister = false
    await expect(timed.close()).resolves.toBeUndefined()
    consoleError.mockRestore()
    await Promise.all([platformA.dispose(), platformB.dispose()])
  })

  it('registers provider disposal as a Context effect', async () => {
    const ctx = new Context()
    let disposeEffect: (() => Promise<void>) | undefined
    vi.spyOn(ctx, 'effect').mockImplementation(((factory: () => () => Promise<void>) => {
      disposeEffect = factory()
      return () => {}
    }) as never)
    const platform = new RemoteRelayProvider(ctx, {
      instanceId: parseRelayInstanceId('platform-effect'),
      routeStore: new SharedRouteStore(), coordinator: new SharedCoordinator(), config: CONFIG,
      randomBytes: uniqueRandomBytes(137),
    })
    await disposeEffect?.()
    await expect(platform.rotateCredential(parseRelayRouteId('route-effect')))
      .rejects.toMatchObject({ code: 'REMOTE_OFFLINE' })
  })

  it('sheds a third attachment through a shared capacity gate while an established desktop-to-mobile frame still delivers', async () => {
    const gate = new MemoryPlatformCapacityGate(2, 2_500)
    const routeStore = new SharedRouteStore()
    const coordinator = new SharedCoordinator()
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-shared-gate'),
      routeStore, coordinator, config: CONFIG, randomBytes: uniqueRandomBytes(201), capacity: gate,
    })
    const routeId = parseRelayRouteId('route-shared-gate')
    const desktopGrant = await platform.rotateCredential(routeId, 'desktop')
    const mobileGrant = await platform.issueCredential(routeId, 'mobile')
    const mobileFrames: RelayCiphertextMessage[] = []
    const desktop = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-established'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => {},
    })
    const mobile = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-established'), endpoint: 'mobile', credential: mobileGrant.credential,
      },
      deliver: async (message) => { mobileFrames.push(message) },
    })
    expect(gate.shedding).toBe(true)
    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-shed'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => {},
    })).rejects.toEqual(expect.objectContaining<Partial<RemoteRelayError>>({
      code: 'PLATFORM_CAPACITY', retryAfterMs: 2_500,
    }))
    const frame = Uint8Array.of(1, 4, 9)
    await desktop.receive(ciphertext(routeId, 'desktop-established', 'mobile-established', frame))
    expect(mobileFrames).toEqual([expect.objectContaining({ ciphertext: frame })])
    await desktop.close()
    await mobile.close()
    expect(gate.shedding).toBe(false)
    const recovered = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-recovered'), endpoint: 'desktop', credential: desktopGrant.credential,
      },
      deliver: async () => {},
    })
    await recovered.close()
    await platform.dispose()
  })

  it('releases a shared capacity gate when maxConnections rejects after acquire', async () => {
    const gate = new MemoryPlatformCapacityGate(4, 1_500)
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-gate-max'),
      routeStore: new SharedRouteStore(), coordinator: new SharedCoordinator(),
      config: { ...CONFIG, maxConnections: 1 }, randomBytes: uniqueRandomBytes(205), capacity: gate,
    })
    const routeId = parseRelayRouteId('route-gate-max')
    const grant = await platform.rotateCredential(routeId)
    const first = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-first'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('mobile-second'), endpoint: 'mobile', credential: grant.credential,
      },
      deliver: async () => {},
    })).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY', retryAfterMs: CONFIG.capacityRetryAfterMs })
    expect(gate.shedding).toBe(false)
    await first.close()
    await platform.dispose()
  })

  it('transfers a shared capacity hold when replacing an attachment', async () => {
    const gate = new MemoryPlatformCapacityGate(1, 1_000)
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-gate-replace'),
      routeStore: new SharedRouteStore(), coordinator: new SharedCoordinator(),
      config: CONFIG, randomBytes: uniqueRandomBytes(207), capacity: gate,
    })
    const routeId = parseRelayRouteId('route-gate-replace')
    const grant = await platform.rotateCredential(routeId)
    const first = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-replace'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    const replacement = await platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId,
        attachmentId: parseRelayAttachmentId('desktop-replace'), endpoint: 'desktop', credential: grant.credential,
      },
      deliver: async () => {},
    })
    expect(gate.shedding).toBe(true)
    await first.close()
    expect(gate.shedding).toBe(true)
    await replacement.close()
    expect(gate.shedding).toBe(false)
    await platform.revokeCredential(grant)
    await platform.dispose()
  })

  it('releases a shared capacity gate when attach authorization fails', async () => {
    const gate = new MemoryPlatformCapacityGate(1, 1_000)
    const platform = new RemoteRelayProvider(new Context(), {
      instanceId: parseRelayInstanceId('platform-gate-release'),
      routeStore: new SharedRouteStore(), coordinator: new SharedCoordinator(),
      config: CONFIG, randomBytes: uniqueRandomBytes(203), capacity: gate,
    })
    await expect(platform.attach({
      message: {
        type: 'attach', transportVersion: 1, routeId: parseRelayRouteId('route-missing'),
        attachmentId: parseRelayAttachmentId('desktop-missing'), endpoint: 'desktop',
        credential: parseRelayCredential('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      },
      deliver: async () => {},
    })).rejects.toMatchObject({ code: 'RELAY_ATTACHMENT_REJECTED' })
    expect(gate.shedding).toBe(false)
    await platform.dispose()
  })
})

function provider(
  id: string,
  routeStore: RelayRouteStore,
  coordinator: RelayCoordinator,
  randomByte: number,
): RemoteRelayProvider {
  return new RemoteRelayProvider(new Context(), {
    instanceId: parseRelayInstanceId(id),
    routeStore,
    coordinator,
    config: CONFIG,
    randomBytes: uniqueRandomBytes(randomByte),
  })
}

/**
 * Deterministic random source whose bytes also differ across calls, so endpoint-scoped
 * credential digests issued by one provider never collide in the shared route store.
 */
function uniqueRandomBytes(seed: number): (size: number) => Uint8Array {
  let issued = 0
  return (size: number): Uint8Array => uniqueBytes(size, seed + ++issued * 101)
}

function uniqueBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (seed + index * 17) & 0xff
  return bytes
}

class SharedRouteStore implements RelayRouteStore {
  uncertain = false
  private readonly routes = new Map<string, {
    authorities: Map<string, 'mobile' | 'desktop'>
    revision: number
    revoked: boolean
  }>()

  async rotate(routeId: string, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const authorities = new Map(current?.authorities ?? [])
    for (const [digest, owner] of authorities) if (owner === endpoint) authorities.delete(digest)
    authorities.set(Buffer.from(credentialDigest).toString('hex'), endpoint)
    this.routes.set(routeId, { authorities, revision, revoked: false })
    return revision
  }

  async issue(routeId: string, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array): Promise<number | undefined> {
    const current = this.routes.get(routeId)
    if (current === undefined || current.revoked) return undefined
    current.authorities.set(Buffer.from(credentialDigest).toString('hex'), endpoint)
    return current.revision
  }

  async authorize(routeId: string, endpoint: 'mobile' | 'desktop', credentialDigest: Uint8Array): Promise<number | undefined> {
    if (this.uncertain) throw new Error('shared route store unavailable')
    const current = this.routes.get(routeId)
    if (current === undefined || current.revoked
      || current.authorities.get(Buffer.from(credentialDigest).toString('hex')) !== endpoint) return undefined
    return current.revision
  }

  async revokeCredential(
    routeId: string,
    endpoint: 'mobile' | 'desktop',
    credentialDigest: Uint8Array,
  ): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    const authorities = new Map(current?.authorities ?? [])
    const digest = Buffer.from(credentialDigest).toString('hex')
    if (authorities.get(digest) === endpoint) authorities.delete(digest)
    this.routes.set(routeId, { authorities, revision, revoked: current?.revoked ?? true })
    return revision
  }

  async revoke(routeId: string): Promise<number> {
    const current = this.routes.get(routeId)
    const revision = (current?.revision ?? 0) + 1
    this.routes.set(routeId, { authorities: new Map(), revision, revoked: true })
    return revision
  }

  advanceRevision(routeId: string): void {
    const current = this.routes.get(routeId)
    if (current === undefined) throw new Error('route missing')
    this.routes.set(routeId, { ...current, revision: current.revision + 1 })
  }
}

class SharedCoordinator implements RelayCoordinator {
  readonly events: RelayCoordinationEvent[] = []
  readonly queuedEventCount = 0
  failStop = false
  failListen = false
  failRegister = false
  failRefresh = false
  failUnregister = false
  refreshCalls = 0
  unregisterCalls = 0
  private readonly directory = new Map<string, RelayDirectoryEntry>()
  private readonly listeners = new Map<string, (event: RelayCoordinationEvent) => Promise<void>>()

  async listen(
    instanceId: string,
    listener: (event: RelayCoordinationEvent) => Promise<void>,
  ): Promise<() => Promise<void>> {
    if (this.failListen) throw new Error('listen failed')
    this.listeners.set(instanceId, listener)
    return async () => {
      this.listeners.delete(instanceId)
      if (this.failStop) throw new Error('stop failed')
    }
  }

  async register(entry: RelayDirectoryEntry): Promise<void> {
    if (this.failRegister) throw new Error('register failed')
    this.directory.set(key(entry.routeId, entry.attachmentId), entry)
  }

  async refresh(entry: RelayDirectoryEntry): Promise<boolean> {
    this.refreshCalls += 1
    if (this.failRefresh) return false
    const current = this.directory.get(key(entry.routeId, entry.attachmentId))
    if (current?.connectionToken !== entry.connectionToken) return false
    this.directory.set(key(entry.routeId, entry.attachmentId), entry)
    return true
  }

  async unregister(entry: RelayDirectoryEntry): Promise<void> {
    this.unregisterCalls += 1
    const entryKey = key(entry.routeId, entry.attachmentId)
    if (this.directory.get(entryKey)?.connectionToken === entry.connectionToken) this.directory.delete(entryKey)
    if (this.failUnregister) throw new Error('unregister failed')
  }

  async locate(routeId: string, attachmentId: string): Promise<RelayDirectoryEntry | undefined> {
    return this.directory.get(key(routeId, attachmentId))
  }

  async publish(instanceId: string, event: RelayCoordinationEvent): Promise<boolean> {
    this.events.push(event)
    const listener = this.listeners.get(instanceId)
    if (listener === undefined) return false
    queueMicrotask(() => { void listener(event).catch(() => {}) })
    return true
  }

  async invalidate(event: Extract<RelayCoordinationEvent, { type: 'invalidate' }>): Promise<void> {
    await Promise.all([...this.listeners.values()].map(listener => listener(event)))
  }

  put(entry: RelayDirectoryEntry): void { this.directory.set(key(entry.routeId, entry.attachmentId), entry) }

  async send(instanceId: string, event: RelayCoordinationEvent): Promise<void> {
    await this.listeners.get(instanceId)?.(event)
  }
}

function key(routeId: string, attachmentId: string): string {
  return `${routeId}:${attachmentId}`
}

function ciphertext(
  routeId: ReturnType<typeof parseRelayRouteId>,
  sourceAttachmentId: string,
  targetAttachmentId: string,
  value: Uint8Array,
): RelayCiphertextMessage {
  return {
    type: 'ciphertext', transportVersion: 1, routeId,
    sourceAttachmentId: parseRelayAttachmentId(sourceAttachmentId),
    targetAttachmentId: parseRelayAttachmentId(targetAttachmentId),
    ciphertext: value,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) resolve()
    else signal?.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
