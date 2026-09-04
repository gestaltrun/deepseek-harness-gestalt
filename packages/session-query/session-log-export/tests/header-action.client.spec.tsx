// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import { SessionLogDownloadToolbarAction } from '../src/client/ToolbarAction.tsx'
import type { SessionLogDownloadToolbarActionProps } from '../src/client/ToolbarAction.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-export-header' as SessionId

function bindSessionExport(controller: SessionLogDownloadController) {
  return function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench() {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const request = vi.fn((sessionId: SessionId) => controller.download(sessionId))
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const useSessionLogDownload = bindSessionExport(controller)
  const props = {
    sessionId: SID,
    useSessionLogDownload,
    request,
    dismiss,
    t: (key: keyof typeof en): string => en[key],
  } as unknown as SessionLogDownloadToolbarActionProps
  const view = render(<SessionLogDownloadToolbarAction {...props} />)
  return { controller, request, view }
}

afterEach(cleanup)

describe('Session export Trajectory toolbar action', () => {
  it('renders the compact text capsule and downloads through the shared controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: en['toolbar.download'] })
    expect(button.querySelector('svg')).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID) })
  })

  it('disables the capsule while either entry path downloads this Session', async () => {
    const b = bench()
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const useSessionLogDownload = bindSessionExport(controller)
    b.view.rerender(<SessionLogDownloadToolbarAction {...({
      sessionId: SID,
      useSessionLogDownload,
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      t: (key: keyof typeof en): string => en[key],
    } as unknown as SessionLogDownloadToolbarActionProps)} />)

    const download = controller.download(SID)
    const button = b.view.getByRole('button', { name: en['toolbar.download'] })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    release(new Response('zip'))
    await download
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
  })
})

describe('Session export Header dialog host', () => {
  it('mounts the shared download dialog on an inner dialog node', async () => {
    const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
    const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
    const useSessionLogDownload = bindSessionExport(controller)
    const view = render(<SessionLogDownloadHeaderAction {...({
      sessionId: SID,
      useSessionLogDownload,
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss,
      t: (key: keyof typeof en): string => en[key],
    } as unknown as SessionLogDownloadDialogProps)} />)

    act(() => {
      controller.store.set({
        bySession: { [SID]: { open: true, status: 'error', error: 'header failed' } },
      })
    })

    const dialog = await view.findByRole('dialog', { name: 'Session export failed' })
    expect(dialog.textContent).toContain('header failed')
    expect(dialog.parentElement?.getAttribute('role')).toBe('presentation')
  })
})
