// DetailsPanel: close button + the selected call's args and
// result — args as JSON, the result raw except for a terminal-card call, whose
// Output section is the command's terminal card. A focused document replaces
// the tool body entirely (the document-focus linkage channel) and dispatches
// by extension: markdown bodies through MarkdownText, html bodies through the
// sandboxed restricted preview, everything else as a bare file tab. Reads the
// selection from the shared chat
// store (conversation writes, this panel reads — the cross-registration
// share the store seat exists for) and derives the call material from the
// session snapshot — no data of its own.

import { Fragment } from 'react'
import { CodeBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { shallowEqual } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, RunningToolCall, ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { DetailsDocumentFocus, DetailsSlotProps } from '../contract/slots.ts'
import { documentRenderKind } from '../contract/views.ts'
import { findToolCall } from '../chat/tool-node-reader.ts'
import css from './DetailsPanel.module.css'

/** Full props composed by reference from the contract (automatic shares & injected share). */
export type DetailsPanelProps = DetailsSlotProps

/**
 * Selected call material: the call's display name and args plus the frozen
 * block slice it came from. `block` is a snapshot-cached reference, so the
 * wrapper stays shallow-equal across unrelated snapshot frames; the settled /
 * running split is read off it with the `'kind' in block` discrimination
 * instead of duplicated as flags.
 */
interface CallMaterial {
  name: string
  argsRaw: string | null
  block: ToolCallBlock
}

/** Material of a settled result node (native call or run_code sub-dispatch). */
function settledMaterial(node: ToolResultNode, callId: string): CallMaterial {
  return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, block: node }
}

/** Material of an in-flight call (native call or run_code sub-dispatch). */
function runningMaterial(call: RunningToolCall): CallMaterial {
  return { name: call.name, argsRaw: call.argsRaw, block: call }
}

function materialFor(s: ConversationSnapshot, callId: string): CallMaterial | null {
  const found = findToolCall(s, callId)
  if (found === undefined) return null
  return 'kind' in found ? settledMaterial(found, callId) : runningMaterial(found)
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Not JSON (streaming fragment or plain text): show verbatim.
    return raw
  }
}

/** Flatten a settled result for the no-ui-tool fallback. */
function rawResultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

const HTML_PREVIEW_ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
  'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
])

const HTML_PREVIEW_DROP_CONTENT_TAGS = new Set([
  'applet', 'base', 'embed', 'frame', 'frameset', 'iframe', 'link', 'meta',
  'noscript', 'object', 'script', 'style', 'template',
])

const HTML_PREVIEW_GLOBAL_ATTRIBUTES = new Set(['dir', 'lang', 'title'])
const HTML_PREVIEW_TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  col: new Set(['span']),
  details: new Set(['open']),
  img: new Set(['alt', 'height', 'src', 'width']),
  li: new Set(['value']),
  ol: new Set(['reversed', 'start', 'type']),
  td: new Set(['colspan', 'headers', 'rowspan']),
  th: new Set(['colspan', 'headers', 'rowspan', 'scope']),
  time: new Set(['datetime']),
}

/** Copy one untrusted node through the preview's inert tag/attribute allowlist. */
function appendRestrictedHtml(parent: Node, node: Node, output: Document): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.appendChild(output.createTextNode(node.textContent ?? ''))
    return
  }
  if (!(node instanceof Element)) return
  const tag = node.tagName.toLowerCase()
  if (HTML_PREVIEW_DROP_CONTENT_TAGS.has(tag)) return
  if (!HTML_PREVIEW_ALLOWED_TAGS.has(tag)) {
    for (const child of [...node.childNodes]) appendRestrictedHtml(parent, child, output)
    return
  }
  const clean = output.createElement(tag)
  const tagAttributes = HTML_PREVIEW_TAG_ATTRIBUTES[tag]
  for (const attribute of [...node.attributes]) {
    const name = attribute.name.toLowerCase()
    if (HTML_PREVIEW_GLOBAL_ATTRIBUTES.has(name) || tagAttributes?.has(name) === true) {
      clean.setAttribute(name, attribute.value)
    }
  }
  for (const child of [...node.childNodes]) appendRestrictedHtml(clean, child, output)
  parent.appendChild(clean)
}

/** Retain inert document markup while removing every active or navigable capability. */
function sanitizeRestrictedHtml(content: string): string {
  const input = new DOMParser().parseFromString(content, 'text/html')
  const output = document.implementation.createHTMLDocument('')
  for (const child of [...input.body.childNodes]) appendRestrictedHtml(output.body, child, output)
  return output.body.innerHTML
}

/** Sanitize relayed HTML, then install a policy before any surviving node parses. */
function restrictedHtmlDocument(content: string): string {
  const sanitized = sanitizeRestrictedHtml(content)
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${sanitized}</body></html>`
}

/**
 * The details panel's focused-document body: the 'conversation.details.document'
 * seat over its three-way dispatch fallback. The html frame has no sandbox
 * grants. An inert allowlist removes active and navigable capabilities, and
 * the first parsed node installs a deny-all policy for passive resources.
 */
function DocumentFocusBody({ document: doc, renderSlot, t }: {
  document: DetailsDocumentFocus
  renderSlot: DetailsSlotProps['renderSlot']
  t: DetailsSlotProps['t']
}) {
  return renderSlot('conversation.details.document', { document: doc }, {
    fallback: (() => {
      const kind = documentRenderKind(doc.filename)
      if (kind === 'markdown') {
        return (
          <section className={css.section}>
            <MarkdownText text={doc.content ?? ''} />
          </section>
        )
      }
      if (kind === 'html') {
        return (
          <section className={css.section}>
            <div className={css.restricted} role="note">{t('details.document.restricted')}</div>
            <iframe
              className={css.frame}
              sandbox=""
              srcDoc={restrictedHtmlDocument(doc.content ?? '')}
              title={doc.filename}
            />
          </section>
        )
      }
      return (
        <div className={css.fileTab}>
          <svg className={css.fileIcon} viewBox="0 0 16 16" width="28" height="28" aria-hidden>
            <path
              d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"
              fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
            />
            <path d="M9 1.5V5.5H13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <div className={css.title}>{doc.filename}</div>
          <div className={css.fileFrom}>{t('details.document.from', { name: doc.from })}</div>
        </div>
      )
    })(),
  })
}

export function DetailsPanel({ useSession, useSessions, sessionId, useStore, renderSlot, closeDetails, t }: DetailsPanelProps) {
  const selection = useStore(s => s.selection)
  // Focused document replaces the tool body while set (the document-focus
  // linkage channel); `?? null` absorbs snapshots persisted before the field.
  const documentFocus = useStore(s => s.documentFocus ?? null)
  // Session workspace root: an omitted or relative terminal cwd resolves
  // against it, which the pure presenter cannot see.
  const sessionCwd = useSessions(list => list.byId[sessionId]?.cwd)
  const callId = selection?.callId
  // materialFor builds a fresh wrapper; shallowEqual short-circuits on its
  // stable members (result node reference rides the snapshot's structural sharing).
  const material = useSession(
    s => (callId === undefined ? null : materialFor(s, callId)),
    (a, b) => shallowEqual(a, b))

  if (selection === null && documentFocus === null) return null

  const focusTitle = documentFocus?.filename ?? material?.name ?? selection?.toolName ?? t('details.title')

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.title}>
          {focusTitle}
        </div>
        <button
          type="button" className={css.close} aria-label={t('details.close')}
          onClick={() => { closeDetails() }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={css.body}>
        {documentFocus !== null
          ? <DocumentFocusBody document={documentFocus} renderSlot={renderSlot} t={t} />
          : callId === undefined
            ? <div className={css.empty}>{t('details.empty')}</div>
            : material === null
              ? <div className={css.empty}>{t('details.notInWindow')}</div>
              : (
                <>
                  {material.argsRaw !== null && (
                    <section className={css.section}>
                      <div className={css.sectionLabel}>{t('details.input')}</div>
                      <CodeBlock code={pretty(material.argsRaw)} lang="json" copyLabel={t('copy')} copiedLabel={t('copied')} />
                    </section>
                  )}
                  <section className={css.section}>
                    <div className={css.sectionLabel}>{t('details.output')}</div>
                    {/* Keyed by the selected call: the body owns per-call view
                      state (the terminal card's expand and copy), which React
                      would otherwise carry into the next selection because the
                      panel does not unmount between calls. */}
                    <Fragment key={callId}>
                      {renderSlot('conversation.details.tool', { block: material.block, cwd: sessionCwd }, {
                        fallback: 'kind' in material.block
                          ? (
                            <pre className={css.code} data-error={material.block.isError || undefined}>
                              {rawResultText(material.block)}
                            </pre>
                          )
                          : <div className={css.empty}>{t('details.running')}</div>,
                      })}
                    </Fragment>
                  </section>
                </>
              )}
      </div>
    </div>
  )
}
