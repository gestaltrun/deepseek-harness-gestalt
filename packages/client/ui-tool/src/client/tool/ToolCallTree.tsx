/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallOwnerProps, ToolTreeProps } from '../contract/slots.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

type ToolCallTreePresentationProps = Pick<
  ToolTreeProps,
  'renderSlot' | 'node' | 'selectedCallId' | 'cwd' | 'useHostDescription' | 't'
> & {
  openFile?: ((path: string) => void) | undefined
  inspectCall?: ToolTreeProps['inspectCall'] | undefined
}

/** Direct Tool tree props without Desktop Chat Node or Host hook fabrication. */
export interface DirectToolCallTreeProps {
  /** Desktop-authoritative root call. */
  block: ToolCallBlock
  /** Render one atomic call through the composition's keyed dispatch. */
  renderCall: (owner: ToolCallOwnerProps) => ReactNode
  /** Selected call identity, when a details route exists. */
  selectedCallId?: string | undefined
  /** Session Workspace root used for path and terminal presentation. */
  cwd?: string | undefined
  /** Host account home used to abbreviate POSIX paths. */
  home?: string | undefined
  /** Open a Host file when the composition owns that capability. */
  openFile?: ((path: string) => void) | undefined
  /** Inspect a call when the composition owns that route. */
  inspectCall?: ((callId: string) => void) | undefined
  /** Select Browser calls when the composition owns Browser details. */
  selectCall?: ((callId: string, toolName?: string) => void) | undefined
}

/** Resolve a Tool call's wire name from either lifecycle form. */
function callName(node: ToolCallBlock): string {
  return 'kind' in node ? node.call?.name ?? '' : node.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderCall, callId, toolName, block, openFile, selected, cwd, home, inspectCall, selectCall, children,
}: Pick<ToolCallTreePresentationProps, 'openFile' | 'cwd' | 'inspectCall'> & {
  renderCall: DirectToolCallTreeProps['renderCall']
  callId: string
  toolName: string
  block: ToolCallBlock
  selected: boolean
  home?: string | undefined
  selectCall?: ((callId: string, toolName?: string) => void) | undefined
  children?: ReactNode
}) {
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    block,
    openFile,
    cwd,
    home,
    inspect: inspectCall === undefined ? undefined : () => { inspectCall(callId) },
  }), [callId, toolName, block, openFile, cwd, home, inspectCall])
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
      data-selected={selected || undefined}
      onClick={toolName.startsWith('browser_') && selectCall !== undefined
        ? () => { selectCall(callId, toolName) }
        : undefined}
    >
      {renderCall(owner)}
      {children}
    </div>
  )
})

/** Render a Tool lifecycle tree through an owner-defined atomic dispatcher. */
export function DirectToolCallTree({
  block, renderCall, selectedCallId, cwd, home, openFile, inspectCall, selectCall,
}: DirectToolCallTreeProps): ReactNode {
  return (
    <ToolCallBranch
      renderCall={renderCall}
      block={block}
      selectedCallId={selectedCallId}
      cwd={cwd}
      home={home}
      openFile={openFile}
      inspectCall={inspectCall}
      selectCall={selectCall}
    />
  )
}

const ToolCallBranch = memo(function ToolCallBranch({
  renderCall, block, selectedCallId, cwd, home, openFile, inspectCall, selectCall,
}: Pick<ToolCallTreePresentationProps, 'selectedCallId' | 'cwd' | 'openFile' | 'inspectCall'> & {
  renderCall: DirectToolCallTreeProps['renderCall']
  block: ToolCallBlock
  home?: string | undefined
  selectCall?: ((callId: string, toolName?: string) => void) | undefined
}) {
  return (
    <ToolCall
      renderCall={renderCall}
      callId={block.callId}
      toolName={callName(block)}
      block={block}
      openFile={openFile}
      selected={block.callId === selectedCallId}
      cwd={cwd}
      home={home}
      inspectCall={inspectCall}
      selectCall={selectCall}
    >
      {block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderCall={renderCall}
              block={child}
              selectedCallId={selectedCallId}
              cwd={cwd}
              home={home}
              openFile={openFile}
              inspectCall={inspectCall}
              selectCall={selectCall}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
})

/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch. A `browser_*` row calls `selectCall` on click.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  renderSlot, node, selectedCallId, cwd, openFile, inspectCall, selectCall, useHostDescription, t,
}: ToolCallTreePresentationProps & {
  selectCall?: ((callId: string, toolName?: string) => void) | undefined
}) {
  const home = useHostDescription(description => description?.home)
  const block = node.data.root
  const renderCall = (owner: ToolCallOwnerProps): ReactNode => renderSlot('tool.call.toolview', owner, {
    entryKey: owner.toolName,
    fallback: <GenericToolCard {...owner} t={t} />,
  })
  return (
    <ToolCallBranch
      renderCall={renderCall}
      block={block}
      selectedCallId={selectedCallId}
      cwd={cwd}
      home={home}
      openFile={openFile}
      inspectCall={inspectCall}
      selectCall={selectCall}
    />
  )
}
