/** Build the documentation site from a clean, resolved output directory. */

import { build } from 'vitepress'
import { documentationBuildOptions } from './build.ts'

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--mpa') || args.filter(arg => arg === '--mpa').length > 1) {
  throw new Error('Usage: tsx website/build-cli.ts [--mpa]')
}
await build(import.meta.dirname, documentationBuildOptions(args[0] === '--mpa'))
