/** Built-in Tool keyed-dispatch roster shared by Desktop slots and direct Web compositions. */

import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolPresentationViewProps } from '../../contract/slots.ts'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import { AskQuestionRow } from './ask-question-row.tsx'
import { BashRow } from './bash-sample.tsx'
import { FileMutationRow } from './file-mutation-row.tsx'
import { ReadRow } from './read-row.tsx'
import { SearchRow } from './search-row.tsx'
import { TodoRow } from './todo-row.tsx'
import { WebRow } from './web-row.tsx'

interface BuiltinToolviewDefinition {
  readonly id: string
  readonly keys: readonly string[]
  readonly View: ComponentType<ToolPresentationViewProps>
}

const BUILTIN_TOOLVIEWS: readonly BuiltinToolviewDefinition[] = [
  { id: 'bash', keys: ['bash'], View: BashRow },
  { id: 'read', keys: ['read'], View: ReadRow },
  { id: 'file-mutation', keys: ['edit', 'write'], View: FileMutationRow },
  { id: 'search', keys: ['grep', 'glob'], View: SearchRow },
  { id: 'web', keys: ['web_search', 'web_fetch'], View: WebRow },
  { id: 'todo', keys: ['todo_write'], View: TodoRow },
  { id: 'ask-user-question', keys: ['ask_user_question'], View: AskQuestionRow },
]

const BY_KEY = new Map(BUILTIN_TOOLVIEWS.flatMap(definition =>
  definition.keys.map(key => [key, definition] as const)))

/**
 * Render one built-in keyed Tool row.
 * @param props - frozen Tool lifecycle owner data and translator.
 * @returns the keyed row, or `null` when the wire Tool name is unclaimed.
 */
export function BuiltinToolview(
  props: ToolPresentationViewProps & { fallback?: ReactNode | undefined },
): ReactNode {
  const definition = BY_KEY.get(props.toolName)
  if (definition === undefined) return props.fallback ?? null
  const View = definition.View
  return <div data-toolview={definition.id}><View {...props} /></div>
}

/** Register the same built-in keyed roster used by direct Web presentation. */
export const builtinToolviews = {
  name: 'builtin-toolviews',
  inject: ['slots'],
  /**
   * Register every built-in wire Tool name in the Tool-owned keyed seat.
   * @param ctx - Client context owning the slot registry lifecycle.
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const definition of BUILTIN_TOOLVIEWS) {
        for (const key of definition.keys) {
          yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, BuiltinToolview)
        }
      }
    })
  },
}
