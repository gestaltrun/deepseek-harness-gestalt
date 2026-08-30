// NODE_OPTIONS preload for the Windows test launcher. A symlinked node.exe
// has no script argument, so this inserts the sibling fake module as argv[1],
// starts it, and keeps Node from resolving the `server` or `agent` subcommand
// as a main-module path. Other Node subprocesses leave through the basename
// guard without importing test behavior.

import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (basename(process.argv0).toLowerCase() === 'fakemobilecli.exe') {
  const fakeModule = join(dirname(process.argv0), 'fakemobilecli.mjs')
  const subcommand = basename(process.argv[1] ?? '')
  process.argv.splice(1, 1, fakeModule, subcommand)
  await import(pathToFileURL(fakeModule).href)
  await new Promise(() => {})
}
