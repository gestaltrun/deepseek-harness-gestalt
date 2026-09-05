#!/usr/bin/env node
/** PATH-first adb intercept: dumpsys logicalFrame and screenrecord H264. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const h264Path = join(dirname(fileURLToPath(import.meta.url)), 'native.h264')

if (args.includes('dumpsys') && args.includes('display')) {
  process.stdout.write('mCurrentOrientation=1\nlogicalFrame=Rect(0, 0 - 2248, 1080)\n')
  process.exit(0)
}

if (args.includes('screenrecord')) {
  process.stdout.write(readFileSync(h264Path))
  const keep = setInterval(() => {}, 60_000)
  const stop = () => {
    clearInterval(keep)
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} else {
  process.stderr.write(`synthetic-adb: unsupported argv ${JSON.stringify(args)}\n`)
  process.exit(1)
}
