// @vitest-environment jsdom
/**
 * The connected phone tab body on the real connection controller driven by
 * a fake gateway: BrowserView-rhythm devbar with the device dropdown and
 * format chips, the 1:2 centered live frame, the circular toolbar, touch →
 * tap/gesture, keyboard → text, and the error/suspend arms with their
 * next-action copy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PhoneConnectedView } from '../src/client/PhoneConnectedView.tsx'
import { PhoneConnectionController } from '../src/client/phone-connection.ts'
import { PhoneStreamHttpError } from '../src/client/phone-stream-client.ts'
import type { PhoneDeviceSummary } from '../src/client/registry.ts'
import { FakeGateway, FakeListingSource, flush, listingOf, ManualScheduler, SESSION_A } from './phone-fakes.client.ts'

afterEach(cleanup)

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
  } as DOMRect)
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
    fireEvent.click(screen.getByRole('menuitem', { name: /SM-S9310/ }))
    expect(harness.onOpenDevice).toHaveBeenCalledWith('R3CN30', 'SM-S9310')
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
    await step(() => { gateway.lastSocket!.accept() })
    expect(gateway.mintedDevices).toEqual(['emulator-5554', 'R3CN30'])
    expect(screen.getByRole('button', { name: '切换设备：SM-S9310' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'SM-S9310 实时画面' })).toBeTruthy()
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
    const img = screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' })
    Object.defineProperty(img, 'naturalWidth', { value: 360 })
    Object.defineProperty(img, 'naturalHeight', { value: 720 })
    fireEvent.load(img)
    stubRect(frame(), 200, 400)
    return harness
  }

  it('sends a tap with device coordinates for a plain click', async () => {
    const { gateway } = await withSurface()
    fireEvent.pointerDown(frame(), { clientX: 100, clientY: 100 })
    fireEvent.pointerUp(frame(), { clientX: 100, clientY: 100 })
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tap',
      params: { deviceId: 'emulator-5554', x: 180, y: 180 },
    })
  })

  it('sends a pointerDown/pointerUp gesture once the drag passes the threshold', async () => {
    const { gateway } = await withSurface()
    fireEvent.pointerDown(frame(), { clientX: 20, clientY: 20 })
    fireEvent.pointerMove(frame(), { clientX: 120, clientY: 220 })
    fireEvent.pointerUp(frame(), { clientX: 130, clientY: 230 })
    expect(JSON.parse(gateway.lastSocket!.sent[0]!)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'gesture',
      params: {
        deviceId: 'emulator-5554',
        actions: [
          { type: 'pointerDown', x: 36, y: 36 },
          { type: 'pointerUp', x: 234, y: 414 },
        ],
      },
    })
  })

  it('types printable input and Enter as text and drops control keys', async () => {
    const { gateway } = await withSurface()
    fireEvent.keyDown(frame(), { key: 'a' })
    fireEvent.keyDown(frame(), { key: 'Enter' })
    fireEvent.keyDown(frame(), { key: 'Backspace' })
    fireEvent.keyDown(frame(), { key: 'c', ctrlKey: true })
    expect(gateway.lastSocket!.sent.map(sentFrame => JSON.parse(sentFrame))).toEqual([
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
    expect(gateway.lastSocket!.sent.map(sentFrame => JSON.parse(sentFrame))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'button', params: { deviceId: 'emulator-5554', button: 'BACK' } },
      { jsonrpc: '2.0', id: 2, method: 'button', params: { deviceId: 'emulator-5554', button: 'HOME' } },
      { jsonrpc: '2.0', id: 3, method: 'button', params: { deviceId: 'emulator-5554', button: 'RECENTS' } },
    ])
  })

  it('refreshes the stream through a brand-new session', async () => {
    const harness = await renderLive()
    fireEvent.click(screen.getByRole('button', { name: '刷新流' }))
    expect(harness.gateway.mintedDevices).toHaveLength(2)
    await flush()
    await step(() => { harness.gateway.lastSocket!.accept() })
    expect((screen.getByRole('img', { name: 'Pixel_6_API_35 实时画面' }) as HTMLImageElement).src)
      .toContain(SESSION_A.h264.url)
  })
})

describe('PhoneConnectedView error and recovery arms', () => {
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
    await act(async () => { harness.gateway.lastSocket!.drop() })
    expect(screen.getByText(/画面重连中/)).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    await step(() => { harness.scheduler.runNext() })
    harness.gateway.lastSocket!.accept()
    await act(async () => {})
    expect(screen.getByText('代理中')).toBeTruthy()
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
