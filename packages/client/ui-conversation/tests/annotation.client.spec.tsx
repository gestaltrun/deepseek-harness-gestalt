// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  compileAnnotationSubmission, createTextAnchor, TextAnnotationId,
} from '../src/client/annotation/model.ts'
import type { TextAnchor } from '../src/client/annotation/model.ts'
import { AnnotationEditor } from '../src/client/annotation/AnnotationEditor.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { zh } from '../src/client/locales.ts'
import {
  removeDraftHighlightOwner, replaceDraftHighlightRanges,
} from '../src/client/annotation/draft-highlights.ts'
import type { SessionInputDeps } from '../src/client/input/facade.ts'

import { SessionInputShell } from '../src/client/input/facade.ts'

function firstTextNode(node: Node): Text {
  for (let current: Node | null = node; current !== null; current = current.firstChild) {
    if (current.nodeType === Node.TEXT_NODE) return current as Text
  }
  throw new Error('expected rendered text')
}

function textPosition(node: Node, value: string): { node: Text; offset: number } {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    const offset = current.textContent?.indexOf(value) ?? -1
    if (offset >= 0) return { node: current as Text, offset }
  }
  throw new Error(`expected rendered text ${JSON.stringify(value)}`)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Compiler labels required by every shell construction (the hub always supplies them). */
const LABELS = {
  heading: (index: number) => `Annotation ${index}`,
  quote: (value: string) => `Quoted text: “${value}”`,
  note: (value: string) => `Note: ${value}`,
  image: (name: string, x: number, y: number) => `Image “${name}” at ${x.toFixed(1)}%, ${y.toFixed(1)}%`,
  overflow: 'Request exceeds context capacity',
}

describe('text annotation mechanics', () => {
  it('anchors an exact repeated quotation with surrounding context', () => {
    const source = 'Alpha repeat middle repeat omega.'
    const anchor = createTextAnchor('message-1', source, 'repeat', 20)

    expect(anchor).toEqual({
      sourceId: 'message-1',
      quote: 'repeat',
      prefix: 'Alpha repeat middle ',
      suffix: ' omega.',
    })
    // Anchor-to-range resolution lives in the renderer projection
    // (MarkdownSelectionMap.rangeForText); stale and ambiguous anchors are
    // covered by the Draft Mark rebuild tests below.
  })

  it('compiles question-first readable prose without an annotation protocol', () => {
    const anchor = createTextAnchor('message-1', 'The exact passage.', 'exact passage', 4)
    const compiled = compileAnnotationSubmission('Please tighten this.', [{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor, note: '',
    }], {
      heading: n => `Annotation ${n}`,
      quote: value => `Quoted text: “${value}”`,
      note: value => `Note: ${value}`,
      image: (name, x, y) => `Image “${name}” at ${x.toFixed(1)}%, ${y.toFixed(1)}%`,
      overflow: 'Request exceeds context capacity',
    })

    expect(compiled).toBe('Please tighten this.\n\nAnnotation 1\nQuoted text: “exact passage”')
    expect(compiled).not.toMatch(/<annotation|json|respond in/i)
  })

  it('rejects a rendered Markdown selection that contains an empty-alt image', () => {
    const view = render(
      <AssistantMarkdown
        blocks={[{ kind: 'text', text: 'before![](https://example.com/pixel.png)after tail' }]}
        streaming={false}
        t={makeTranslate(zh, commonZh)}
        sourceId="message-1"
        annotations={[]}
        annotationActions={{ addTextAnnotation: () => TextAnnotationId('annotation-1') }}
      />,
    )
    const paragraph = view.container.querySelector('p')!
    const beforeLeaf = paragraph.childNodes[0]!
    const afterLeaf = paragraph.childNodes[2]!
    const before = beforeLeaf.firstChild ?? beforeLeaf
    const after = afterLeaf.firstChild ?? afterLeaf
    const range = document.createRange()
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!

    range.setStart(before, 0)
    range.setEnd(after, 5)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    expect(view.queryByRole('toolbar')).toBeNull()

    range.setStart(afterLeaf, 0)
    range.setEnd(afterLeaf, 1)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    expect(view.getByRole('toolbar')).toBeDefined()

    range.setStart(after, 0)
    range.setEnd(paragraph, 3)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    expect(view.queryByRole('toolbar')).toBeNull()
  })

  it('keyboard selection across Markdown shows only annotate/copy before the shared editor', () => {
    const add = vi.fn(() => TextAnnotationId('annotation-1'))
    const view = render(
      <AssistantMarkdown
        blocks={[{ kind: 'text', text: 'Alpha **bold** omega' }]}
        streaming={false}
        t={makeTranslate(zh, commonZh)}
        sourceId="message-1"
        annotations={[]}
        annotationActions={{ addTextAnnotation: add }}
      />,
    )
    const parts = view.container.querySelector('p')!.childNodes
    const range = document.createRange()
    range.setStart(parts[0]!.firstChild!, 0)
    range.setEnd(parts[2]!.firstChild!, 6)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    expect(view.getByRole('toolbar').textContent).toBe('添加注释复制')
    selection.removeAllRanges()
    fireEvent(document, new Event('selectionchange'))
    expect(view.queryByRole('toolbar')).toBeNull()

    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    expect(view.getByRole('toolbar').textContent).toBe('添加注释复制')
    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    const editor = view.getByPlaceholderText('添加说明（可选）')
    fireEvent.change(editor, { target: { value: 'Tighten this' } })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(add).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ quote: 'Alpha bold omega' }), 'Tighten this')
  })

  it('annotates visible inline code through the composed Markdown selection path', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{ kind: 'text' as const, text: 'before `code` after' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    const view = render(<AssistantMarkdown {...props} annotations={[]} />)
    const code = firstTextNode(view.container.querySelector('code')!)
    const range = document.createRange()
    range.setStart(code, 0)
    range.setEnd(code, 4)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    fireEvent.click(view.getByRole('button', { name: '保存注释' }))
    expect(saved?.quote).toBe('code')
    if (saved === undefined) throw new Error('expected saved inline-code annotation')
    view.unmount()
    render(<AssistantMarkdown {...props} annotations={[{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
    }]} />)
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges.map(item => item.toString())).toEqual(['code'])
  })

  it('preserves an exact selection spanning ordinary text and inline code', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{ kind: 'text' as const, text: 'before `code` after' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    const view = render(<AssistantMarkdown {...props} annotations={[]} />)
    const leaves = view.container.querySelector('p')!.childNodes
    const range = document.createRange()
    range.setStart(firstTextNode(leaves[0]!), 0)
    range.setEnd(firstTextNode(leaves[2]!), 6)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    fireEvent.click(view.getByRole('button', { name: '保存注释' }))
    expect(saved?.quote).toBe('before code after')
    if (saved === undefined) throw new Error('expected saved cross-inline annotation')
    view.unmount()
    render(<AssistantMarkdown {...props} annotations={[{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
    }]} />)
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges.map(item => item.toString())).toEqual(['before code after'])
  })

  it('keeps repeated-quote context in the renderer projection', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{ kind: 'text' as const, text: 'A          repeat x repeat' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    const view = render(<AssistantMarkdown {...props} annotations={[]} />)
    const text = firstTextNode(view.container.querySelector('p')!)
    const range = document.createRange()
    range.setStart(text, 11)
    range.setEnd(text, 17)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    fireEvent.click(view.getByRole('button', { name: '保存注释' }))
    expect(saved).toMatchObject({ quote: 'repeat', prefix: 'A          ', suffix: ' x repeat' })
    if (saved === undefined) throw new Error('expected saved repeated-quote annotation')
    view.unmount()
    render(<AssistantMarkdown {...props} annotations={[{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
    }]} />)
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges).toHaveLength(1)
    expect(mark.ranges[0]?.startOffset).toBe(11)
  })

  it('annotates ordinary fenced-code text through the composed Markdown path', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{
        kind: 'text' as const,
        text: '```ts\nconst ready = true\nreturn ready\n```\n\n```\nplain fallback\n```',
      }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    const view = render(<AssistantMarkdown {...props} annotations={[]} />)
    const start = textPosition(view.container.querySelector('.md-code-block')!, 'ready')
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(start.node, start.offset + 'ready'.length)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    fireEvent.click(view.getByRole('button', { name: '保存注释' }))
    expect(saved?.quote).toBe('ready')
    if (saved === undefined) throw new Error('expected saved fenced-code annotation')
    view.unmount()
    render(<AssistantMarkdown {...props} annotations={[{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
    }]} />)
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges.map(item => item.toString())).toEqual(['ready'])
  })

  it('keeps one source-ordered fence contribution across a copy-state rerender', async () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{ kind: 'text' as const, text: 'before\n\n```ts\nconst ready = true\n```\n\nafter' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    try {
      const view = render(<AssistantMarkdown {...props} annotations={[]} />)
      fireEvent.click(view.getByRole('button', { name: '复制' }))
      await view.findByRole('button', { name: '复制成功' })
      const start = textPosition(view.container.querySelector('.md-code-block')!, 'ready')
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(start.node, start.offset + 'ready'.length)
      Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      fireEvent(document, new Event('selectionchange'))

      fireEvent.click(view.getByRole('button', { name: '添加注释' }))
      fireEvent.click(view.getByRole('button', { name: '保存注释' }))
      expect(saved).toMatchObject({ quote: 'ready', prefix: 'beforeconst ', suffix: ' = trueafter' })
      if (saved === undefined) throw new Error('expected saved rerendered-fence annotation')
      view.unmount()
      render(<AssistantMarkdown {...props} annotations={[{
        id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
      }]} />)
      const mark = set.mock.lastCall?.[1] as FakeHighlight
      expect(mark.ranges.map(item => item.toString())).toEqual(['ready'])
    } finally {
      if (clipboard === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard
      else Object.defineProperty(navigator, 'clipboard', clipboard)
    }
  })

  it('replaces the plain fence contribution after a lazy grammar loads', async () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{ kind: 'text' as const, text: 'before\n\n```python\nready = True\n```\n\nafter' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    const view = render(<AssistantMarkdown {...props} annotations={[]} />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    await vi.waitFor(() => { expect(view.container.querySelector('pre.shiki')).not.toBeNull() })
    const start = textPosition(view.container.querySelector('.md-code-block')!, 'ready')
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(start.node, start.offset + 'ready'.length)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    fireEvent.click(view.getByRole('button', { name: '保存注释' }))
    expect(saved).toMatchObject({ quote: 'ready', prefix: 'before', suffix: ' = Trueafter' })
    if (saved === undefined) throw new Error('expected saved lazy-fence annotation')
    view.unmount()
    render(<AssistantMarkdown {...props} annotations={[{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
    }]} />)
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges.map(item => item.toString())).toEqual(['ready'])
  })

  it('annotates raw HTML that the Markdown renderer exposes as literal text', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    let saved: TextAnchor | undefined
    const props = {
      blocks: [{ kind: 'text' as const, text: 'before <tag>raw</tag> after' }],
      streaming: false,
      t: makeTranslate(zh, commonZh),
      sourceId: 'message-1',
      annotationActions: {
        addTextAnnotation: (anchor: TextAnchor) => {
          saved = anchor
          return TextAnnotationId('annotation-1')
        },
      },
    }
    const view = render(<AssistantMarkdown {...props} annotations={[]} />)
    const start = textPosition(view.container.querySelector('p')!, '<tag>')
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(start.node, start.offset + '<tag>'.length)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    fireEvent.click(view.getByRole('button', { name: '添加注释' }))
    fireEvent.click(view.getByRole('button', { name: '保存注释' }))
    expect(saved?.quote).toBe('<tag>')
    if (saved === undefined) throw new Error('expected saved raw-HTML annotation')
    view.unmount()
    render(<AssistantMarkdown {...props} annotations={[{
      id: TextAnnotationId('annotation-1'), kind: 'text', anchor: saved, note: '',
    }]} />)
    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges.map(item => item.toString())).toEqual(['<tag>'])
  })

  it('rejects a selection spanning generated math chrome', () => {
    const view = render(
      <AssistantMarkdown
        blocks={[{ kind: 'text', text: 'before $x$ after' }]}
        streaming={false}
        t={makeTranslate(zh, commonZh)}
        sourceId="message-1"
        annotations={[]}
        annotationActions={{ addTextAnnotation: () => TextAnnotationId('annotation-1') }}
      />,
    )
    const paragraph = view.container.querySelector('p')!
    const before = textPosition(paragraph, 'before ')
    const after = textPosition(paragraph, ' after')
    const range = document.createRange()
    range.setStart(before.node, before.offset)
    range.setEnd(after.node, after.offset + ' after'.length)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    expect(view.queryByRole('toolbar')).toBeNull()
  })

  it('dismisses a pending toolbar when the selection grows across messages', () => {
    const view = render(
      <div>
        <AssistantMarkdown
          blocks={[{ kind: 'text', text: 'First message' }]}
          streaming={false}
          t={makeTranslate(zh, commonZh)}
          sourceId="message-1"
          annotations={[]}
          annotationActions={{ addTextAnnotation: () => TextAnnotationId('annotation-1') }}
        />
        <AssistantMarkdown
          blocks={[{ kind: 'text', text: 'Second message' }]}
          streaming={false}
          t={makeTranslate(zh, commonZh)}
          sourceId="message-2"
          annotations={[]}
          annotationActions={{ addTextAnnotation: () => TextAnnotationId('annotation-2') }}
        />
      </div>,
    )
    const messages = view.container.querySelectorAll('p')
    const first = messages[0]!.firstChild!.firstChild!
    const second = messages[1]!.firstChild!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(first, 0)
    range.setEnd(first, 5)
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 20, bottom: 40 }) })
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    expect(view.getByRole('toolbar')).toBeDefined()

    range.setEnd(second, 6)
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))

    expect(view.queryByRole('toolbar')).toBeNull()
  })

  it('keeps the floating toolbar on its anchor across scroll and resize', async () => {
    const rect = { left: 20, bottom: 40 }
    // jsdom ships no Range geometry: define it once on the prototype so both
    // the captured selection and its cloned anchor range resolve the same rect.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect,
    })
    try {
      const view = render(
        <AssistantMarkdown
          blocks={[{ kind: 'text', text: 'Alpha beta gamma' }]}
          streaming={false}
          t={makeTranslate(zh, commonZh)}
          sourceId="message-1"
          annotations={[]}
          annotationActions={{ addTextAnnotation: () => TextAnnotationId('annotation-1') }}
        />,
      )
      const text = firstTextNode(view.container.querySelector('p')!)
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 5)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      fireEvent(document, new Event('selectionchange'))
      const floating = view.getByRole('toolbar').parentElement!
      expect(floating.style.getPropertyValue('--annotation-left')).toBe('20px')
      expect(floating.style.getPropertyValue('--annotation-top')).toBe('48px')

      rect.left = 120
      rect.bottom = 200
      fireEvent(window, new Event('scroll'))
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      expect(floating.style.getPropertyValue('--annotation-left')).toBe('120px')
      expect(floating.style.getPropertyValue('--annotation-top')).toBe('208px')

      rect.left = 40
      rect.bottom = 60
      fireEvent(window, new Event('resize'))
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      expect(floating.style.getPropertyValue('--annotation-left')).toBe('40px')
      expect(floating.style.getPropertyValue('--annotation-top')).toBe('68px')
    } finally {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
    }
  })

  it('defers the composition guard so Safari closing Enter never saves', () => {
    vi.useFakeTimers()
    try {
      const save = vi.fn()
      const view = render(
        <AnnotationEditor placeholder="Optional note" saveLabel="Save annotation" onSave={save} />,
      )
      const editor = view.getByPlaceholderText('Optional note')
      fireEvent.compositionStart(editor)
      fireEvent.compositionEnd(editor)
      fireEvent.keyDown(editor, { key: 'Enter' })
      expect(save).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20)
      fireEvent.keyDown(editor, { key: 'Enter' })
      expect(save).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits annotation-only prose through one owned reservation and clears only after admission', () => {
    const sink = vi.fn<SessionInputDeps['defaultSink']>(() => new Promise(() => {}))
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: sink,
      annotationLabels: LABELS,
    })
    const anchor = createTextAnchor('message-1', 'Exact quotation', 'Exact quotation', 0)
    const id = shell.actions.addTextAnnotation(anchor, '')
    shell.submit()
    expect(sink).toHaveBeenCalledWith(
      'Annotation 1\nQuoted text: “Exact quotation”',
      [],
      'queue',
      expect.any(AbortSignal),
    )
    expect(shell.snapshot.annotations).toHaveLength(1)
    const reservation = shell.annotationReservation
    expect(reservation).toEqual({ restoreText: '', ids: [id] })
    if (reservation === undefined) throw new Error('annotation submission was not reserved')
    expect(shell.snapshot.annotationSubmitting).toBe(true)
    shell.submit()
    shell.actions.updateTextAnnotation(id, 'must not replace the submitted snapshot')
    shell.actions.removeTextAnnotation(id)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(shell.snapshot.annotations[0]?.note).toBe('')
    shell.settleAnnotationSubmission(reservation, true)
    expect(shell.snapshot.annotations).toEqual([])
    expect(shell.snapshot.annotationSubmitting).toBe(false)
  })

  it('failure releases the reservation without deleting its annotations', async () => {
    const sink = vi.fn<SessionInputDeps['defaultSink']>()
      .mockImplementationOnce(() => Promise.resolve({ kind: 'error' }))
      .mockImplementation(() => new Promise(() => {}))
    const shell = new SessionInputShell({ actx: {} as Context, defaultSink: sink, annotationLabels: LABELS })
    shell.setDraft('Please revise this.')
    const anchor = createTextAnchor('message-1', 'Exact quotation', 'Exact quotation', 0)
    const id = shell.actions.addTextAnnotation(anchor, 'Original note')

    shell.submit()
    const reservation = shell.annotationReservation
    expect(reservation).toEqual({ restoreText: 'Please revise this.', ids: [id] })
    if (reservation === undefined) throw new Error('annotation submission was not reserved')
    shell.submit()
    shell.setDraft('A later edit must not enter the admitted snapshot.')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(shell.snapshot.draft).toBe('Please revise this.')
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    shell.settleAnnotationSubmission(reservation, false)

    expect(shell.snapshot.annotationSubmitting).toBe(false)
    expect(shell.snapshot.annotations).toEqual([{ id, kind: 'text', anchor, note: 'Original note' }])
    shell.actions.updateTextAnnotation(id, 'Retry note')
    shell.submit()
    expect(sink).toHaveBeenCalledTimes(2)
    const retry = shell.annotationReservation
    expect(retry).toBeDefined()
    if (retry === undefined) throw new Error('annotation retry was not reserved')
    shell.settleAnnotationSubmission(reservation, true)
    expect(shell.snapshot.annotationSubmitting).toBe(true)
    expect(shell.snapshot.annotations[0]?.note).toBe('Retry note')
    shell.settleAnnotationSubmission(retry, true)
    expect(shell.snapshot.annotations).toEqual([])
  })

  it('edits and deletes an unsent annotation through the Composer actions', () => {
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: () => Promise.resolve({ kind: 'success' }),
      annotationLabels: LABELS,
    })
    const anchor = createTextAnchor('message-1', 'Exact quotation', 'Exact quotation', 0)
    const id = shell.actions.addTextAnnotation(anchor, '')

    shell.actions.updateTextAnnotation(id, 'Revised note')
    expect(shell.snapshot.annotations[0]?.note).toBe('Revised note')
    shell.actions.removeTextAnnotation(id)
    expect(shell.snapshot.annotations).toEqual([])
  })

  it('aggregates Draft Marks from multiple mounted text targets without cross-deletion', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    const deleteMark = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: deleteMark } })
    vi.stubGlobal('Highlight', FakeHighlight)
    const firstOwner = {}
    const secondOwner = {}
    const firstRange = document.createRange()
    const secondRange = document.createRange()

    replaceDraftHighlightRanges(firstOwner, [firstRange])
    replaceDraftHighlightRanges(secondOwner, [secondRange])
    expect((set.mock.lastCall?.[1] as FakeHighlight).ranges).toEqual([firstRange, secondRange])

    removeDraftHighlightOwner(firstOwner)
    expect((set.mock.lastCall?.[1] as FakeHighlight).ranges).toEqual([secondRange])
    removeDraftHighlightOwner(secondOwner)
    expect(deleteMark).toHaveBeenLastCalledWith('annotation-draft-mark')
  })

  it('rebuilds a Draft Mark from its Text Anchor after the Markdown target mounts again', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    const anchor = createTextAnchor('message-1:0', 'Alpha bold middle bold omega', 'bold', 18)

    const view = render(
      <AssistantMarkdown
        blocks={[{ kind: 'text', text: 'Alpha **bold** middle **bold** omega' }]}
        streaming={false}
        t={makeTranslate(zh, commonZh)}
        sourceId="message-1"
        annotations={[{ id: TextAnnotationId('annotation-1'), kind: 'text', anchor, note: '' }]}
        annotationActions={{ addTextAnnotation: () => TextAnnotationId('unused') }}
      />,
    )

    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges).toHaveLength(1)
    expect(mark.ranges[0]?.toString()).toBe('bold')
    expect(mark.ranges[0]?.startContainer.parentElement?.parentElement).toBe(
      view.container.querySelectorAll('strong')[1],
    )
  })

  it('does not rebuild Draft Marks through renderer whitespace or image registrations', () => {
    class FakeHighlight {
      readonly ranges: readonly Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    const set = vi.fn()
    vi.stubGlobal('CSS', { highlights: { set, delete: vi.fn() } })
    vi.stubGlobal('Highlight', FakeHighlight)
    const normalized = 'Alpha betaimageomegatail'
    const rendererProjection = 'Alpha   betaimageomegatail'

    render(
      <AssistantMarkdown
        blocks={[{
          kind: 'text',
          text: 'Alpha   beta![image](https://example.com/pixel.png)omega![](https://example.com/empty.png)tail',
        }]}
        streaming={false}
        t={makeTranslate(zh, commonZh)}
        sourceId="message-1"
        annotations={[
          {
            id: TextAnnotationId('normalized-whitespace'), kind: 'text',
            anchor: createTextAnchor('message-1:0', normalized, 'Alpha beta', 0), note: '',
          },
          {
            id: TextAnnotationId('image-fragment'), kind: 'text',
            anchor: createTextAnchor('message-1:0', rendererProjection, 'betaimageomega', 8), note: '',
          },
          {
            id: TextAnnotationId('empty-alt-fragment'), kind: 'text',
            anchor: createTextAnchor('message-1:0', rendererProjection, 'omegatail', 17), note: '',
          },
          {
            id: TextAnnotationId('valid-text'), kind: 'text',
            anchor: createTextAnchor('message-1:0', rendererProjection, 'omega', 17), note: '',
          },
        ]}
        annotationActions={{ addTextAnnotation: () => TextAnnotationId('unused') }}
      />,
    )

    const mark = set.mock.lastCall?.[1] as FakeHighlight
    expect(mark.ranges).toHaveLength(1)
    expect(mark.ranges[0]?.toString()).toBe('omega')
  })
})
