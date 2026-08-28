#!/usr/bin/env node
/** Boot the keyless project-members composition and stream one turn as canonical JSONL. */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const NAME = 'project-members-example'
const [configPath] = process.argv.slice(2)
if (configPath === undefined) throw new Error(`${NAME}: expected <config-path>`)

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  const observe = (sessionId: string, event: SessionEvent): void => {
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
  }
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const result = await runFixtureTurn(ctx, {
    task: 'List the demo project roster with the project_members tool.',
    onEvent: observe,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
