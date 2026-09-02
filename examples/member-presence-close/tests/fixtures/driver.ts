#!/usr/bin/env node
/** Boot the real keyless last-window Offline Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('member-presence-close driver requires a config path')

const ctx = await boot('member-presence-close-keyless', resolveConfigPath(configPath, undefined))
await ctx.fiber.dispose()
