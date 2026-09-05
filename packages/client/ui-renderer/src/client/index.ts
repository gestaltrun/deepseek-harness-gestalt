/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OwnerOf, SessionSlotKey } from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'
import { SlotRegistry } from './registry.ts'

export { SlotRegistry } from './registry.ts'
export type { RootOwnerProps } from './registry.ts'

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SnapshotSelectorHook, SlotRenderer,
  ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Mount operation exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
  /**
   * Mount one declared Session-scoped slot without changing shell selection.
   * @param container - independent React mount point.
   * @param slotKey - declared non-root Session or Session-maybe slot.
   * @param sessionId - Session identity resolved by the installed adapter.
   * @param ownerProps - owner props for the slot occurrence.
   * @returns idempotent disposer that unmounts the independent React root.
   */
  mountSession: <K extends SessionSlotKey>(
    container: HTMLElement,
    slotKey: K,
    sessionId: SessionId,
    ownerProps: OwnerOf<K>,
  ) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A slot declaration or registration set changed.
     * @mode emit
     * @param key - mutated SlotMap key.
     */
    'slots/changed'(key: string): void
  }
  interface Context {
    /** Renderer-owned UI composition registry. */
    slots: SlotRegistry
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService
  }
}

/** Services required before application assembly. */
export const inject: string[] = []

interface BootSnapshot {
  className: string
  html: string
}

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }))
  }
  const root = createRoot(container)
  flushSync(() => { root.render(app()) })
  return root
}

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const slots = new SlotRegistry(ctx)
  const roots = new Map<Root, () => void>()
  slots.install(createSlotRenderer())
  ctx.effect(() => () => {
    for (const [root, release] of [...roots]) {
      roots.delete(root)
      root.unmount()
      release()
    }
  }, 'ui-renderer: mounted React roots')

  const ownRoot = (root: Root, release: () => void = () => {}): (() => void) => {
    roots.set(root, release)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      roots.delete(root)
      root.unmount()
      release()
    }
  }

  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) =>
      ownRoot(mountApp(container, buildRenderApp({ ctx }))),
    mountSession: <K extends SessionSlotKey>(
      container: HTMLElement,
      slotKey: K,
      sessionId: SessionId,
      ownerProps: OwnerOf<K>,
    ): (() => void) => {
      const prepared = slots.prepareSessionSlot(slotKey, sessionId, ownerProps)
      const root = createRoot(container)
      try {
        flushSync(() => { root.render(prepared.element) })
      } catch (error) {
        root.unmount()
        prepared.release()
        throw error
      }
      return ownRoot(root, prepared.release)
    },
  })
}
