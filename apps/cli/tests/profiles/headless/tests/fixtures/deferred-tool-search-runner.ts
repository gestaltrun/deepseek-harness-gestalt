/** Profile-overlay runner for the deferred discovery restart snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const inject = ['agents', 'sessions']

interface Config {
  readonly task: string
}

/** Drive the configured root agent and expose only canonical session events. */
async function run(ctx: Context, task: string): Promise<void> {
  const configuredAgent = Promise.withResolvers<undefined>()
  const disposeCreated = ctx.on('agent/created', () => { configuredAgent.resolve(undefined) })
  const disposeFailed = ctx.on('agent-loop/config-start-failed', ({ error }) => {
    configuredAgent.reject(error)
  })
  try {
    await ctx.get('loader')?.await()
    if ((ctx.get('agents')?.roots().length ?? 0) === 0) {
      await configuredAgent.promise
    }
  } finally {
    disposeCreated()
    disposeFailed()
  }
  const agents = ctx.get('agents')?.roots() ?? []
  const [agent] = agents ?? []
  if (agent === undefined || agents?.length !== 1) {
    throw new Error(`deferred snapshot requires one configured root agent, found ${agents?.length ?? 0}`)
  }
  if (task.trim() === '') throw new Error('deferred snapshot requires the shipped headless startup task')
  await agent.whenIdle()
  const message = createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  })
  const events: SessionEvent[] = []
  let received = false
  let output = ''
  let finishTurn!: () => void
  const turnFinished = new Promise<void>((resolve) => { finishTurn = resolve })
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (!received) {
      if (event.type !== 'agent/inbox/spliced'
        || !event.data.inserted.some(inserted => inserted.id === message.id)) return
      received = true
    }
    events.push(event)
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text !== '') output = text
    }
    if (event.type === 'turn/end') finishTurn()
  })
  try {
    agent.followup(message)
    await turnFinished
    await agent.whenIdle()
  } finally {
    disposeListener()
  }
  await ctx.get('sessions')?.flush(agent.session)
  for (const event of events) process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: agent.session.id, event })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'result', sessionId: agent.session.id, output })}\n`)
  ctx.get('appExit')?.(0)
}

/** Start after the shipped profile has settled, then request bounded app exit. */
export function apply(ctx: Context, config: Config): void {
  void run(ctx, config.task).catch((error: unknown) => {
    process.stderr.write(`deferred snapshot: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
}
