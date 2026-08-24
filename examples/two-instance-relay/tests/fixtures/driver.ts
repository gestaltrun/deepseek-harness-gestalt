#!/usr/bin/env node
/** Boot the real Snow two-instance Relay Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('two-instance Relay driver requires a config path')

const ctx = await boot('two-instance-relay-snow', resolveConfigPath(configPath, undefined))
await ctx.fiber.dispose()
