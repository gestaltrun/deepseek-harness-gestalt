/** Deferred tool used by the TypeScript SDK durable-result snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['tools']

/** Register one deterministic deferred tool in the scenario-owned Loader fiber. */
export function apply(ctx: Context): void {
  ctx.tools.register({
    ...defineTool({
      name: 'sdk_deferred_echo',
      description: 'Echo a value after schema discovery.',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async args => `SDK deferred: ${args.value}`,
    }),
    deferLoading: true,
  })
}
