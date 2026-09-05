import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'
import {
  assembledRequestOverflows, compileAnnotationSubmission, createTextAnchor, isAnimatedGif,
  pinPercentFromClientPoint, TextAnnotationId,
} from '../src/client/annotation/model.ts'

const LABELS = {
  heading: (index: number) => `Annotation ${index}`,
  quote: (value: string) => `Quoted text: “${value}”`,
  note: (value: string) => `Note: ${value}`,
  image: (name: string, x: number, y: number) => `Image “${name}” at ${x.toFixed(1)}%, ${y.toFixed(1)}%`,
  overflow: 'Request exceeds context capacity',
}

describe('composer image pin annotations', () => {
  it('compiles mixed text and image pins in creation order', () => {
    const anchor = createTextAnchor('message-1', 'The exact passage.', 'exact passage', 4)
    const compiled = compileAnnotationSubmission('Look here.', [
      { id: TextAnnotationId('annotation-1'), kind: 'text', anchor, note: '' },
      {
        id: TextAnnotationId('annotation-2'), kind: 'image-pin', imageId: 'img-1', source: 'composer',
        imageName: 'shot.png', x: 12.5, y: 80, note: 'this corner',
      },
    ], LABELS)
    expect(compiled).toBe([
      'Look here.',
      'Annotation 1\nQuoted text: “exact passage”',
      'Annotation 2\nImage “shot.png” at 12.5%, 80.0%\nNote: this corner',
    ].join('\n\n'))
    expect(compiled).not.toMatch(/<annotation|json|respond in/i)
  })

  it('converts a displayed-raster click into clamped percentages', () => {
    expect(pinPercentFromClientPoint(30, 40, { left: 10, top: 10, width: 100, height: 50 }))
      .toEqual({ x: 20, y: 60 })
    expect(pinPercentFromClientPoint(-10, 999, { left: 0, top: 0, width: 10, height: 10 }))
      .toEqual({ x: 0, y: 100 })
  })

  it('refuses animated GIFs and accepts a single-frame GIF header as static', () => {
    const animated = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x00, 0x2c,
    ])
    const staticGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x00, 0x3b,
    ])
    expect(isAnimatedGif(animated)).toBe(true)
    expect(isAnimatedGif(staticGif)).toBe(false)
    expect(isAnimatedGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
  })

  it('keeps text and image pins in one order and drops pins when their image is removed', () => {
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: () => Promise.resolve({ kind: 'success' }),
      annotationLabels: LABELS,
    })
    const imageId = 'draft-1' as DraftAttachmentId
    shell.addImages([imageId])
    const textId = shell.actions.addTextAnnotation(
      createTextAnchor('message-1', 'The exact passage.', 'exact passage', 4),
      '',
    )
    const pinId = shell.actions.addImagePin(imageId, 'shot.png', 10, 20, '')
    expect(shell.snapshot.annotations.map(item => item.id)).toEqual([textId, pinId])
    shell.actions.updateImagePin(pinId, { x: 33, note: 'moved' })
    const pin = shell.snapshot.annotations[1]
    expect(pin?.kind === 'image-pin' && pin.x === 33 && pin.note === 'moved').toBe(true)
    shell.removeImage(imageId)
    expect(shell.snapshot.annotations.map(item => item.id)).toEqual([textId])
  })

  it('forwards a history pin source through the public action face', () => {
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: () => Promise.resolve({ kind: 'success' }),
      annotationLabels: LABELS,
    })
    const imageId = 'sha256:history' as DraftAttachmentId
    shell.actions.addImagePin(imageId, 'shot.png', 10, 20, '', 'history')
    const pin = shell.snapshot.annotations[0]
    expect(pin?.kind === 'image-pin' && pin.source === 'history' && pin.imageId === imageId).toBe(true)
  })

  it('rejects a known-capacity overflow without claiming the request fits', () => {
    expect(assembledRequestOverflows(40, 10, 19)).toBe(true)
    expect(assembledRequestOverflows(8, 10, 20)).toBe(false)
  })
})
