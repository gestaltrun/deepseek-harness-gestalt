/**
 * Outside-pointer dismissal for trigger-owned popovers: while the surface is
 * open, a pointerdown outside the trigger root and optional portal closes it.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Close an open popover when a pointerdown lands outside its root element.
 * @param root - element containing the trigger and any in-tree surface.
 * @param open - whether the surface is showing; false detaches the listener.
 * @param setOpen - state setter invoked with false on an outside pointerdown.
 * @param portalRoot - optional portaled surface that also counts as inside.
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portalRoot?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target) || portalRoot?.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portalRoot])
}
