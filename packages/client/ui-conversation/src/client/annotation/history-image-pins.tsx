import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ComposerBarProps, MessageImagePinOverlay } from '../contract/slots.ts'
import type { InputActions, InputState } from '../input/contract.ts'
import { useImagePinOverlay } from './image-pin-overlay.tsx'

/**
 * History-image pin overlay plus the shared note editor for one opened preview.
 * @param annotations - Current draft items.
 * @param actions - Pin create/update actions; absence disables the overlay.
 * @param t - Conversation locale seat.
 * @returns Gallery overlay factory, or undefined when pinning is unavailable.
 */
export function useHistoryImagePinOverlay(
  annotations: InputState['annotations'],
  actions: Pick<InputActions, 'addImagePin' | 'updateImagePin'> | undefined,
  t: ComposerBarProps['t'],
): {
  pinOverlayFor?: (attachment: ImageAttachmentRef) => MessageImagePinOverlay
} {
  return useImagePinOverlay(annotations, actions, t, {
    source: 'history',
    imageId: attachment => attachment.attachmentId,
    imageName: (attachment, fallback) => attachment.name ?? fallback,
    place: (live, attachment, x, y, name) => live.addImagePin(
      attachment.attachmentId as never, name, x, y, '', 'history',
    ),
  })
}
