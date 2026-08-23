#!/usr/bin/env node
/** Boot the real local companion Platform Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('local-companion-platform driver requires a config path')

const ctx = await boot('local-companion-platform-keyless', resolveConfigPath(configPath, undefined))
await ctx.fiber.dispose()
