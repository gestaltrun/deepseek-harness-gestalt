#!/usr/bin/env node
/**
 * Boot an external `cordis.yml` for the keyless Android capture-source Host wire.
 * Positional `argv[2]` is the config path; there is no working-directory fallback.
 * @module @deepseek-ai/dsh-phone-capture-wire-demo/bin
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'phone-capture-wire-keyless'
const configPath = process.argv[2]
if (configPath === undefined) throw new Error(`${NAME} driver requires a config path`)

const ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
await ctx.fiber.dispose()
