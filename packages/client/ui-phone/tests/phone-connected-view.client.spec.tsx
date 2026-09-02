// @vitest-environment jsdom
/**
 * The connected phone tab body on the real connection controller driven by
 * a fake gateway: BrowserView-rhythm devbar with the device dropdown and
 * format chips, the 1:2 centered live frame, the circular toolbar, touch →
 * tap/gesture, keyboard → text, and the error/suspend arms with their
 * next-action copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PhoneConnectedView } from '../src/client/PhoneConnectedView.tsx'
import { PhoneConnectionController } from '../src/client/phone-connection.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import type { PhoneDeviceSummary } from '../src/client/registry.ts'
import {
  FakeGateway, FakeListingSource, flush, installFakeH264Playback, listingOf, ManualScheduler, SESSION_A,
} from './phone-fakes.client.ts'

let h264Runtime: ReturnType<typeof installFakeH264Playback>

beforeEach(() => {
  h264Runtime = installFakeH264Playback()
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const DEVICES: readonly PhoneDeviceSummary[] = [
  { id: 'emulator-5554', name: 'Pixel_6_API_35', channel: 'emulator', state: 'online', online: true },
  { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'online', online: true },
  { id: 'offline-1', name: 'Galaxy_A54_API_34', channel: 'emulator', state: 'offline', online: false },
  { id: 'unauth-1', name: 'Pixel_8', channel: 'usb', state: 'unauthorized', online: false },
]

interface Harness {
  readonly gateway: FakeGateway
  readonly scheduler: ManualScheduler
  readonly source: FakeListingSource
  readonly onOpenDevice: ReturnType<typeof vi.fn>
}

function renderView(visible = true, mintError?: unknown, source = new FakeListingSource().seed(listingOf(DEVICES))): Harness {
  const gateway = new FakeGateway()
  const scheduler = new ManualScheduler()
  const onOpenDevice = vi.fn()
  // The gateway consumes its script synchronously at connect time, so the
  // outcome must be queued before the mount effect runs.
  if (mintError !== undefined) gateway.queueMint({ error: mintError })
  render(
    <PhoneConnectedView
      serial="emulator-5554"
      name="Pixel_6_API_35"
      visible={visible}
      source={source}
      onOpenDevice={onOpenDevice}
      createController={serial => new PhoneConnectionController({
        gateway,
        deviceId: serial,
        schedule: scheduler.schedule,
      })}
    />,
  )
  return { gateway, scheduler, source, onOpenDevice }
}

/** Drive one async step inside act so controller transitions reach the DOM. */
async function step(body: () => void): Promise<void> {
  await act(async () => {
    body()
    await flush()
  })
}

/** Stub the live frame's geometry for coordinate mapping assertions. */
function stubRect(el: Element, width: number, height: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}),
  })
}

async function renderLive(): Promise<Harness> {
  const harness = renderView()
  await flush()
  await step(() => { harness.gateway.lastSocket!.accept() })
  return harness
}

function frame(): HTMLElement {
  return screen.getByRole('application', { name: /Pixel_6_API_35 画面/ })
}

function parseSentFrame(value: string): unknown {
  return JSON.parse(value)
}

describe('PhoneConnectedView chrome', () => {
  it('renders the devbar rhythm: device dropdown, format chips, and the 1:2 frame', async () => {
    await renderLive()
    expect(screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' })).toBeTruthy()
    const h264 = screen.getByLabelText('当前画面编码 H264 · 30 fps')
    expect(h264.textContent).toContain('H264')
    expect(h264.textContent).toContain('30 fps')
    expect(screen.queryByText('MJPEG')).toBeNull()
    expect(screen.queryByRole('button', { name: /H264/ })).toBeNull()
    expect(screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })).toBeTruthy()
    expect(screen.getByText('代理中')).toBeTruthy()
    expect(screen.getByText(/点击画面即向设备发送触控/)).toBeTruthy()
  })

  it('does not delegate the raw H264 elementary stream to an image element', async () => {
    await renderLive()
    const surface = screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })
    expect(surface).not.toBeInstanceOf(HTMLImageElement)
  })

  it('switches the actual-format badge and touch surface to MJPEG after H264 playback fails', async () => {
    const harness = await renderLive()
    await act(async () => { h264Runtime.failLastDecoder(); await flush() })

    expect(screen.queryByLabelText('当前画面编码 H264 · 30 fps')).toBeNull()
    expect(screen.getByLabelText('当前画面编码 MJPEG').textContent).toContain('MJPEG')
    expect(screen.queryByText(/decode failed/)).toBeNull()
    const surface = screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })
    expect(surface).toBeInstanceOf(HTMLImageElement)
    expect(surface.getAttribute('src')).toBe('/phone/stream/emulator-5554/mjpeg?token=a')
    Object.defineProperties(surface, {
      naturalWidth: { configurable: true, value: 1080 },
      naturalHeight: { configurable: true, value: 2400 },
    })
    fireEvent.load(surface)
    stubRect(frame(), 270, 600)
    fireEvent.pointerDown(frame(), { clientX: 135, clientY: 300 })
    fireEvent.pointerUp(frame(), { clientX: 135, clientY: 300 })
    expect(parseSentFrame(harness.gateway.lastSocket!.sent[0]!)).toMatchObject({
      method: 'tap', params: { x: 540, y: 1200 },
    })
  })

  it('enters the existing retry arm only after the MJPEG fallback element fails', async () => {
    const harness = await renderLive()
    await act(async () => { h264Runtime.failLastDecoder(); await flush() })
    const surface = screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })
    await act(async () => { fireEvent.error(surface); await flush() })
    expect(screen.getByText(/画面重连中（第 1 次尝试）/)).toBeTruthy()
    expect(harness.scheduler.scheduledCount).toBe(1)
  })

  it('hides the live frame and shows the suspend note while the tab is hidden', async () => {
    renderView(false)
    await flush()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/已暂停/)).toBeTruthy()
  })

  it('renders the design unauthorized arm from the listing instead of a dead stream', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    gateway.queueMint({ error: new PhoneStreamHttpError(502, 'upstream', 'device unauthorized: allow USB debugging') })
    render(
      <PhoneConnectedView
        serial="R3CN30"
        name="SM-S9310"
        visible={true}
        source={new FakeListingSource().seed(listingOf([
          { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'unauthorized', online: false },
        ]))}
        onOpenDevice={() => {}}
        createController={() => new PhoneConnectionController({
          gateway,
          deviceId: 'R3CN30',
          schedule: scheduler.schedule,
        })}
      />,
    )
    await act(async () => { await flush() })
    // The arm replaces the stream area until the device is authorized; the
    // copy is the design's, and the next action reconnects after authorizing.
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('真机未授权调试')).toBeTruthy()
    expect(screen.getByText(/已通过 USB 连接；请在手机上允许「USB 调试」后重新连接/)).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    // The devpick dot reads the warn state, not offline.
    expect(document.querySelector('._dotOffline_')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    expect(gateway.mintedDevices).toHaveLength(2)
    await flush()
    await step(() => { gateway.lastSocket!.accept() })
    expect(screen.getByRole('img', { name: 'SM-S9310 实时画面' })).toBeTruthy()
  })

  it('keeps the live stream up when the stale listing still flags unauthorized', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    render(
      <PhoneConnectedView
        serial="R3CN30"
        name="SM-S9310"
        visible={true}
        source={new FakeListingSource().seed(listingOf([
          { id: 'R3CN30', name: 'SM-S9310', channel: 'usb', state: 'unauthorized', online: false },
        ]))}
        onOpenDevice={() => {}}
        createController={() => new PhoneConnectionController({
          gateway,
          deviceId: 'R3CN30',
          schedule: scheduler.schedule,
        })}
      />,
    )
    await act(async () => { await flush() })
    gateway.lastSocket!.accept()
    await act(async () => {})
    expect(screen.getByRole('img', { name: 'SM-S9310 实时画面' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('dials the minted io path from the session', async () => {
    const harness = await renderLive()
    expect(harness.gateway.dialedPaths).toEqual(['/phone/ws/io'])
  })

  it('opens the device dropdown and asks the opener to focus another device', async () => {
    const harness = await renderLive()
    fireEvent.click(screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' }))
    const menu = screen.getByRole('menu', { name: '切换设备' })
    expect(menu.textContent).toContain('当前')
    fireEvent.click(screen.getByRole('menuitem', { name: /Pixel_6_API_35/ }))
    expect(harness.onOpenDevice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /SM-S9310/ }))
    expect(harness.onOpenDevice).toHaveBeenCalledWith('R3CN30', 'SM-S9310')
  })

  it('keeps the switcher open for unrelated keys and closes it on Escape', async () => {
    await renderLive()
    const trigger = screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' })
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('menu', { name: '切换设备' })).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '切换设备' })).toBeNull()
  })

  it('lists only online devices in the switcher and keeps unauthorized off the menu', async () => {
    await renderLive()
    fireEvent.click(screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' }))
    const items = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(items.some(text => text?.includes('Pixel_6_API_35'))).toBe(true)
    expect(items.some(text => text?.includes('SM-S9310'))).toBe(true)
    expect(screen.queryByRole('menuitem', { name: /Galaxy_A54_API_34/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Pixel_8/ })).toBeNull()
  })

  it('rebuilds the live session for the new serial when the same tab switches devices', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const source = new FakeListingSource().seed(listingOf(DEVICES))
    const { rerender } = render(
      <PhoneConnectedView
        serial="emulator-5554"
        name="Pixel_6_API_35"
        visible={true}
        source={source}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({
          gateway,
          deviceId: serial,
          schedule: scheduler.schedule,
        })}
      />,
    )
    await flush()
    await step(() => { gateway.lastSocket!.accept() })
    await vi.waitFor(() => { expect(h264Runtime.abortSignals).toHaveLength(1) })
    const firstPlayback = h264Runtime.abortSignals[0]!
    expect(gateway.mintedDevices).toEqual(['emulator-5554'])
    rerender(
      <PhoneConnectedView
        serial="R3CN30"
        name="SM-S9310"
        visible={true}
        source={source}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({
          gateway,
          deviceId: serial,
          schedule: scheduler.schedule,
        })}
      />,
    )
    await flush()
    expect(firstPlayback.aborted).toBe(true)
    await step(() => { gateway.lastSocket!.accept() })
    await vi.waitFor(() => { expect(h264Runtime.abortSignals).toHaveLength(2) })
    expect(gateway.mintedDevices).toEqual(['emulator-5554', 'R3CN30'])
    expect(screen.getByRole('button', { name: '切换设备：SM-S9310' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'SM-S9310 实时画面' })).toBeTruthy()
  })

  it('cancels playback while inactive and starts a fresh decoder after resume', async () => {
    const gateway = new FakeGateway()
    const scheduler = new ManualScheduler()
    const source = new FakeListingSource().seed(listingOf(DEVICES))
    const props = {
      serial: 'emulator-5554',
      name: 'Pixel_6_API_35',
      source,
      onOpenDevice: () => {},
      createController: (serial: string) => new PhoneConnectionController({
        gateway, deviceId: serial, schedule: scheduler.schedule,
      }),
    }
    const { rerender } = render(<PhoneConnectedView {...props} visible={true} />)
    await flush()
    await step(() => { gateway.lastSocket!.accept() })
    await vi.waitFor(() => { expect(h264Runtime.abortSignals).toHaveLength(1) })

    rerender(<PhoneConnectedView {...props} visible={false} />)
    await act(async () => {})
    expect(h264Runtime.abortSignals[0]!.aborted).toBe(true)
    expect(h264Runtime.decoderCloseCounts[0]).toBe(1)
    expect(screen.queryByRole('img')).toBeNull()

    rerender(<PhoneConnectedView {...props} visible={true} />)
    await flush()
    await step(() => { gateway.lastSocket!.accept() })
    await vi.waitFor(() => { expect(h264Runtime.abortSignals).toHaveLength(2) })
    expect(h264Runtime.abortSignals[1]!.aborted).toBe(false)
    expect(screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })).toBeTruthy()
  })

  it('lights the dropdown from the mount pull when the tab restores empty', async () => {
    const source = new FakeListingSource()
    source.scriptNext(listingOf(DEVICES))
    renderView(true, undefined, source)
    await act(async () => { await flush() })
    expect(source.refreshCount).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' }))
    expect(screen.getByRole('menuitem', { name: /SM-S9310/ })).toBeTruthy()
  })

  it('keeps the chrome rendered when the mount pull fails', async () => {
    const source = new FakeListingSource()
    source.scriptNext(Promise.reject(new Error('host down')))
    renderView(true, undefined, source)
    await act(async () => { await flush() })
    expect(screen.getByRole('button', { name: '切换设备：Pixel_6_API_35' })).toBeTruthy()
  })
})

describe('PhoneConnectedView touch and keys', () => {
  async function withSurface(): Promise<Harness> {
    const harness = await renderLive()
    const canvas = screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' }) as HTMLCanvasElement
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 390, height: 844 })
    stubRect(frame(), 200, 400)
    return harness
  }

  it('sends a tap with device coordinates for a plain click', async () => {
    const { gateway } = await withSurface()
    fireEvent.pointerDown(frame(), { clientX: 100, clientY: 100 })
    fireEvent.pointerUp(frame(), { clientX: 100, clientY: 100 })
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 195, y: 211 },
    })
  })

  it('captures the pointer and sends the WDA press-hold swipe from origin to release', async () => {
    const { gateway } = await withSurface()
    const target = frame()
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(target, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      setPointerCapture: { configurable: true, value: setPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })
    fireEvent.pointerDown(target, { pointerId: 7, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(target, { pointerId: 7, clientX: 22, clientY: 22 })
    fireEvent.pointerMove(target, { pointerId: 7, clientX: 120, clientY: 220 })
    fireEvent.pointerMove(target, { pointerId: 7, clientX: 125, clientY: 225 })
    fireEvent.pointerUp(target, { pointerId: 7, clientX: 130, clientY: 230 })
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'gesture',
      params: {
        deviceId: 'emulator-5554',
        actions: [
          { type: 'pointerMove', x: 39, y: 42 },
          { type: 'pointerDown' },
          { type: 'pause', duration: 500 },
          { type: 'pointerMove', x: 254, y: 485 },
          { type: 'pause', duration: 200 },
          { type: 'pointerUp' },
        ],
      },
    })
  })

  it('treats a release that crosses the threshold as a drag without an intermediate move', async () => {
    const { gateway } = await withSurface()
    fireEvent.pointerDown(frame(), { pointerId: 10, clientX: 20, clientY: 20 })
    fireEvent.pointerUp(frame(), { pointerId: 10, clientX: 30, clientY: 30 })
    expect(parseSentFrame(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'gesture',
      params: {
        deviceId: 'emulator-5554',
        actions: [
          { type: 'pointerMove', x: 39, y: 42 },
          { type: 'pointerDown' },
          { type: 'pause', duration: 500 },
          { type: 'pointerMove', x: 59, y: 63 },
          { type: 'pause', duration: 200 },
          { type: 'pointerUp' },
        ],
      },
    })
  })

  it('releases pointer capture and drops a cancelled drag', async () => {
    const { gateway } = await withSurface()
    const target = frame()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(target, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })
    fireEvent.pointerDown(target, { pointerId: 8, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(target, { pointerId: 9, clientX: 120, clientY: 220 })
    fireEvent.pointerUp(target, { pointerId: 9, clientX: 120, clientY: 220 })
    fireEvent.pointerCancel(target, { pointerId: 9, clientX: 120, clientY: 220 })
    expect(releasePointerCapture).not.toHaveBeenCalled()
    fireEvent.pointerMove(target, { pointerId: 8, clientX: 120, clientY: 220 })
    fireEvent.pointerCancel(target, { pointerId: 8, clientX: 120, clientY: 220 })
    expect(releasePointerCapture).toHaveBeenCalledWith(8)
    expect(gateway.lastSocket!.sent).toEqual([])
  })

  it('drops stray pointer events and keeps sub-threshold travel as a tap', async () => {
    const { gateway } = await withSurface()
    fireEvent.pointerMove(frame(), { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(frame(), { clientX: 10, clientY: 10 })
    expect(gateway.lastSocket!.sent).toEqual([])

    fireEvent.pointerDown(frame(), { clientX: 50, clientY: 50 })
    fireEvent.pointerMove(frame(), { clientX: 53, clientY: 54 })
    fireEvent.pointerUp(frame(), { clientX: 53, clientY: 54 })
    expect(parseSentFrame(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 103, y: 114 },
    })
  })

  it('coalesces a trackpad wheel burst into one WDA swipe', async () => {
    const { gateway } = await withSurface()
    vi.useFakeTimers()
    try {
      fireEvent.wheel(frame(), { deltaY: 0, deltaMode: 0 })
      fireEvent.wheel(frame(), { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE })
      fireEvent.wheel(frame(), { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE })
      expect(gateway.lastSocket!.sent).toEqual([])
      await act(async () => { vi.advanceTimersByTime(50) })
      expect(parseSentFrame(gateway.lastSocket!.sent[0]!)).toMatchObject({
        jsonrpc: '2.0', id: 1, method: 'gesture',
        params: {
          deviceId: 'emulator-5554',
          actions: [
            { type: 'pointerMove', x: 195 },
            { type: 'pointerDown' },
            { type: 'pause', duration: 500 },
            { type: 'pointerMove', x: 195 },
            { type: 'pause', duration: 200 },
            { type: 'pointerUp' },
          ],
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an in-flight wheel burst when the connected view unmounts', async () => {
    const { gateway } = await withSurface()
    vi.useFakeTimers()
    try {
      fireEvent.wheel(frame(), { deltaY: 80, deltaMode: 0 })
      cleanup()
      await act(async () => { vi.advanceTimersByTime(50) })
      expect(gateway.lastSocket!.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a captured press when the tab hides or switches to another device', async () => {
    const firstGateway = new FakeGateway()
    const secondGateway = new FakeGateway()
    const source = new FakeListingSource().seed(listingOf([
      { id: 'device-a', name: 'Device A', channel: 'usb', state: 'online', online: true },
      { id: 'device-b', name: 'Device B', channel: 'usb', state: 'online', online: true },
    ]))
    const view = render(
      <PhoneConnectedView
        serial="device-a"
        name="Device A"
        visible={true}
        source={source}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({
          gateway: serial === 'device-a' ? firstGateway : secondGateway,
          deviceId: serial,
        })}
      />,
    )
    await flush()
    await step(() => { firstGateway.lastSocket!.accept() })
    let target = screen.getByRole('application', { name: /Device A 画面/ })
    const releasePointerCapture = vi.fn()
    Object.defineProperties(target, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })
    fireEvent.pointerDown(target, { pointerId: 11, clientX: 20, clientY: 20 })

    view.rerender(
      <PhoneConnectedView
        serial="device-a" name="Device A" visible={false} source={source} onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({ gateway: firstGateway, deviceId: serial })}
      />,
    )
    expect(releasePointerCapture).toHaveBeenCalledWith(11)
    view.rerender(
      <PhoneConnectedView
        serial="device-a" name="Device A" visible={true} source={source} onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({ gateway: firstGateway, deviceId: serial })}
      />,
    )
    await flush()
    await step(() => { firstGateway.lastSocket!.accept() })
    target = screen.getByRole('application', { name: /Device A 画面/ })
    fireEvent.pointerUp(target, { pointerId: 11, clientX: 120, clientY: 220 })
    expect(firstGateway.sockets.flatMap(socket => socket.sent)).toEqual([])

    Object.defineProperties(target, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      setPointerCapture: { configurable: true, value: vi.fn() },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })
    fireEvent.pointerDown(target, { pointerId: 12, clientX: 20, clientY: 20 })
    view.rerender(
      <PhoneConnectedView
        serial="device-b" name="Device B" visible={true} source={source} onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({ gateway: secondGateway, deviceId: serial })}
      />,
    )
    await flush()
    await step(() => { secondGateway.lastSocket!.accept() })
    fireEvent.pointerUp(
      screen.getByRole('application', { name: /Device B 画面/ }),
      { pointerId: 12, clientX: 120, clientY: 220 },
    )
    expect(releasePointerCapture).toHaveBeenCalledWith(12)
    expect(firstGateway.sockets.flatMap(socket => socket.sent)).toEqual([])
    expect(secondGateway.sockets.flatMap(socket => socket.sent)).toEqual([])
  })

  it('maps a zero-size rendered frame to the safe zero coordinate', async () => {
    const { gateway } = await renderLive()
    stubRect(frame(), 0, 0)
    fireEvent.pointerDown(frame(), { clientX: 50, clientY: 50 })
    fireEvent.pointerUp(frame(), { clientX: 50, clientY: 50 })
    expect(parseSentFrame(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 0, y: 0 },
    })
  })

  it('types printable input and Enter as text and drops control keys', async () => {
    const { gateway } = await withSurface()
    fireEvent.keyDown(frame(), { key: 'a' })
    fireEvent.keyDown(frame(), { key: 'Enter' })
    fireEvent.keyDown(frame(), { key: 'Backspace' })
    fireEvent.keyDown(frame(), { key: 'c', ctrlKey: true })
    expect(gateway.lastSocket!.sent.map(parseSentFrame)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'text', params: { deviceId: 'emulator-5554', text: 'a' } },
      { jsonrpc: '2.0', id: 2, method: 'text', params: { deviceId: 'emulator-5554', text: '\n' } },
    ])
  })
})

describe('PhoneConnectedView toolbar', () => {
  it('sends the nav buttons and refuses the not-yet-wired screenshot', async () => {
    const { gateway } = await renderLive()
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(screen.getByRole('button', { name: '主屏幕' }))
    fireEvent.click(screen.getByRole('button', { name: '最近任务' }))
    const screenshot = screen.getByRole('button', { name: '截图' }) as HTMLButtonElement
    expect(screenshot.disabled).toBe(true)
    expect(gateway.lastSocket!.sent.map(parseSentFrame)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'button', params: { deviceId: 'emulator-5554', button: 'BACK' } },
      { jsonrpc: '2.0', id: 2, method: 'button', params: { deviceId: 'emulator-5554', button: 'HOME' } },
      { jsonrpc: '2.0', id: 3, method: 'button', params: { deviceId: 'emulator-5554', button: 'RECENTS' } },
    ])
  })

  it('refreshes the stream through a brand-new session', async () => {
    const harness = await renderLive()
    const firstPlayback = h264Runtime.abortSignals[0]!
    fireEvent.click(screen.getByRole('button', { name: '刷新流' }))
    expect(firstPlayback.aborted).toBe(true)
    expect(harness.gateway.mintedDevices).toHaveLength(2)
    await flush()
    await step(() => { harness.gateway.lastSocket!.accept() })
    const canvas = screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' }) as HTMLCanvasElement
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 390, height: 844 })
  })
})

describe('PhoneConnectedView error and recovery arms', () => {
  it('installs a missing real-iPhone agent and reaches live GUI control', async () => {
    const gateway = new FakeGateway()
    gateway.queueMint({ error: new PhoneStreamHttpError(409, 'PHONE_AGENT_MISSING', 'agent missing') })
    gateway.queueMint({ session: {
      ...SESSION_A,
      deviceId: 'UDID-9',
      agentManaged: true,
    } })
    render(
      <PhoneConnectedView
        serial="UDID-9"
        name="Yishu iPhone"
        visible={true}
        source={new FakeListingSource().seed(listingOf([], [
          { id: 'UDID-9', name: 'Yishu iPhone', channel: 'usb', state: 'online', online: true },
        ]))}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({ gateway, deviceId: serial })}
      />,
    )
    await step(() => {})
    expect(screen.getByText('设备控制代理未安装')).toBeTruthy()
    const install = screen.getByRole('button', { name: '安装设备控制代理' })
    const detect = screen.getByRole('button', { name: '重新检测' })
    expect(install.className).toContain('minibtnPrimary')
    expect(detect.className).toContain('minibtnSecondary')
    fireEvent.click(install)
    expect(screen.getByText('正在安装设备控制代理…')).toBeTruthy()
    await flush()
    await step(() => { gateway.lastSocket!.accept() })
    expect(screen.getByRole('img', { name: 'Yishu iPhone 实时画面' })).toBeTruthy()
    expect(gateway.agentInstallCalls).toEqual([{ deviceId: 'UDID-9', force: false }])
  })

  it('keeps one-click Android agent preparation visible when USB installation is restricted', async () => {
    const gateway = new FakeGateway()
    gateway.queueMint({ error: new PhoneStreamHttpError(409, 'PHONE_AGENT_MISSING', 'agent missing') })
    gateway.queueAgentInstall({
      error: new PhoneStreamHttpError(
        502, 'PHONE_UPSTREAM', 'adb install failed: INSTALL_FAILED_USER_RESTRICTED',
      ),
    })
    render(
      <PhoneConnectedView
        serial="fbcd1d21"
        name="MI 8"
        visible={true}
        source={new FakeListingSource().seed(listingOf([
          { id: 'fbcd1d21', name: 'MI 8', channel: 'usb', state: 'online', online: true },
        ], []))}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({ gateway, deviceId: serial })}
      />,
    )
    await step(() => {})
    fireEvent.click(screen.getByRole('button', { name: '安装设备控制代理' }))
    await flush()
    expect(screen.getByText('设备拒绝安装控制代理')).toBeTruthy()
    expect(screen.getByText(/USB 调试（安全设置）/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装设备控制代理' })).toBeTruthy()
  })

  it('renders every structured real-iPhone prerequisite without claiming automatic signing or trust', async () => {
    const cases = [
      ['device-locked', '请解锁 iPhone', 'iPhone 已锁定'],
      ['agent-profile-required', '打开配置文件', '未配置真机签名描述文件'],
      ['cert-untrusted', 'Developer Mode', '设备控制代理未受信任'],
      ['profile-expired', '重新安装设备控制代理', '签名描述文件已过期'],
      ['tunnel-failed', '重新连接', '真机连接通道未建立'],
      ['device-unplugged', '重新连接', 'iPhone 已断开连接'],
    ] as const
    for (const [issue, action, title] of cases) {
      const gateway = new FakeGateway()
      gateway.queueMint({
        error: issue === 'agent-profile-required'
          ? new PhoneStreamHttpError(409, 'PHONE_AGENT_PROFILE_REQUIRED', issue)
          : new PhoneStreamHttpError(502, 'PHONE_REAL_DEVICE_ISSUE', issue, issue),
      })
      const mounted = render(
        <PhoneConnectedView
          serial="UDID-9"
          name="Yishu iPhone"
          visible={true}
          source={new FakeListingSource().seed(listingOf([], [
            { id: 'UDID-9', name: 'Yishu iPhone', channel: 'usb', state: 'online', online: true },
          ]))}
          onOpenDevice={() => {}}
          createController={serial => new PhoneConnectionController({ gateway, deviceId: serial })}
        />,
      )
      await step(() => {})
      expect(screen.getByText(title)).toBeTruthy()
      expect(screen.getAllByText(new RegExp(action)).length).toBeGreaterThan(0)
      mounted.unmount()
    }
  })

  it('shows the agent-check and force-reinstall progress states', async () => {
    const checkingGateway = new FakeGateway()
    checkingGateway.queueMint({ session: { ...SESSION_A, deviceId: 'UDID-9', agentManaged: true } })
    vi.spyOn(checkingGateway, 'agentStatus').mockReturnValue(new Promise(() => {}))
    const checking = render(
      <PhoneConnectedView
        serial="UDID-9"
        name="Yishu iPhone"
        visible={true}
        source={new FakeListingSource().seed(listingOf([], [
          { id: 'UDID-9', name: 'Yishu iPhone', channel: 'usb', state: 'online', online: true },
        ]))}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({
          gateway: checkingGateway, deviceId: serial, retryLimit: 0,
        })}
      />,
    )
    await flush()
    await step(() => { checkingGateway.lastSocket!.accept() })
    await act(async () => { h264Runtime.failLastDecoder(); await flush() })
    await act(async () => {
      fireEvent.error(screen.getByRole('img', { name: 'Yishu iPhone 实时画面' }))
      await flush()
    })
    expect(screen.getByText('正在检测设备控制代理…')).toBeTruthy()
    checking.unmount()

    const reinstallGateway = new FakeGateway()
    reinstallGateway.queueMint({ error: new PhoneStreamHttpError(
      502, 'PHONE_REAL_DEVICE_ISSUE', 'profile expired', 'profile-expired',
    ) })
    vi.spyOn(reinstallGateway, 'installAgent').mockReturnValue(new Promise(() => {}))
    render(
      <PhoneConnectedView
        serial="UDID-9"
        name="Yishu iPhone"
        visible={true}
        source={new FakeListingSource().seed(listingOf([], [
          { id: 'UDID-9', name: 'Yishu iPhone', channel: 'usb', state: 'online', online: true },
        ]))}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({ gateway: reinstallGateway, deviceId: serial })}
      />,
    )
    await step(() => {})
    fireEvent.click(screen.getByRole('button', { name: '重新安装设备控制代理' }))
    expect(screen.getByText('正在重新安装设备控制代理…')).toBeTruthy()
  })

  it('shows the refused and unavailable next-action copy', async () => {
    renderView(true, new PhoneStreamHttpError(403, 'forbidden', 'forbidden'))
    await step(() => {})
    expect(screen.getByText('画面流被拒绝')).toBeTruthy()
    expect(screen.getByText(/宿主拒绝了本次画面会话/)).toBeTruthy()
    cleanup()

    const gateway = new FakeGateway()
    gateway.queueMint({ error: new TypeError('network down') })
    render(
      <PhoneConnectedView
        serial="emulator-5554"
        name="Pixel_6_API_35"
        visible={true}
        source={new FakeListingSource().seed(listingOf(DEVICES))}
        onOpenDevice={() => {}}
        createController={serial => new PhoneConnectionController({
          gateway,
          deviceId: serial,
          retryLimit: 0,
        })}
      />,
    )
    await step(() => {})
    expect(screen.getByText('无法连接设备画面')).toBeTruthy()
    expect(screen.getByText(/画面服务暂时不可达/)).toBeTruthy()
  })

  it('shows the offline card with the reconnect next action when mint 404s', async () => {
    const harness = renderView(true, new PhoneStreamHttpError(404, 'not-found', 'absent from the latest device listing'))
    await step(() => {})
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('设备已离线')).toBeTruthy()
    expect(screen.getByText(/已从设备清单消失/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await flush()
    await step(() => { harness.gateway.lastSocket!.accept() })
    expect(screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })).toBeTruthy()
  })

  it('shows the unauthorized warn card when the upstream refuses debugging', async () => {
    const harness = renderView(true, new PhoneStreamHttpError(502, 'upstream', 'device unauthorized: allow USB debugging'))
    await step(() => {})
    expect(screen.getByText('真机未授权调试')).toBeTruthy()
    expect(screen.getByText(/允许「USB 调试」/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await flush()
    await step(() => { harness.gateway.lastSocket!.accept() })
    expect(screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })).toBeTruthy()
  })

  it('shows the reconnecting note between interruption retries', async () => {
    const harness = await renderLive()
    const firstPlayback = h264Runtime.abortSignals[0]!
    await act(async () => { harness.gateway.lastSocket!.drop() })
    expect(firstPlayback.aborted).toBe(true)
    expect(screen.getByText(/画面重连中/)).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    await step(() => { harness.scheduler.runNext() })
    harness.gateway.lastSocket!.accept()
    await act(async () => {})
    expect(screen.getByText('代理中')).toBeTruthy()
  })

  it('releases the failed H264 decoder while the same session falls back to MJPEG', async () => {
    await renderLive()
    await act(async () => { h264Runtime.failLastDecoder() })
    expect(screen.getByLabelText('当前画面编码 MJPEG')).toBeTruthy()
    expect(h264Runtime.abortSignals[0]!.aborted).toBe(true)
    expect(h264Runtime.decoderCloseCounts[0]).toBe(1)
  })

  it('releases H264 playback when the connected view unmounts', async () => {
    await renderLive()
    cleanup()
    expect(h264Runtime.abortSignals[0]!.aborted).toBe(true)
    expect(h264Runtime.decoderCloseCounts[0]).toBe(1)
    expect(h264Runtime.frameCloseCounts).toEqual([1])
  })

  it('surfaces the interrupted error card once the retry budget is spent', async () => {
    const harness = await renderLive()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => { harness.gateway.lastSocket!.drop() })
      await step(() => { harness.scheduler.runNext() })
      harness.gateway.lastSocket!.accept()
      await act(async () => {})
    }
    await act(async () => { harness.gateway.lastSocket!.drop() })
    expect(screen.getByText('画面流中断')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await flush()
    await step(() => { harness.gateway.lastSocket!.accept() })
    expect(screen.getByText('代理中')).toBeTruthy()
  })
})
