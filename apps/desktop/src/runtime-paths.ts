/**
 * Resolve Node, the dsh bin, and the Desktop overlay for dev vs packaged runs.
 * @module @deepseek-ai/dsh-desktop/runtime-paths
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Paths the Desktop Host needs to spawn Web Host. */
export interface DesktopRuntimePaths {
  /** Official Node (never Electron). */
  readonly node: string
  /** argv after node, starting at the dsh entry. */
  readonly args: readonly string[]
  /** Desktop `--patch` overlay. */
  readonly patch: string
  /**
   * Unpackaged source-launch cwd (the repo root). Packaged runs use the
   * Launch Directory instead so `tsx` is not required.
   */
  readonly workspaceRoot?: string
}

/**
 * Web Host argv after the dsh entry. `--patch` stays ahead of app flags.
 * `--no-open` keeps the OS default browser closed: Desktop Host already
 * loads the Session Surface in its own window.
 * @param patch - Desktop overlay path.
 * @returns `web --patch … --no-open --host 127.0.0.1 --port 0`.
 */
function webHostArgs(patch: string): string[] {
  return ['web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0']
}

/**
 * Resolve spawn paths.
 * @param options.packaged - Electron `app.isPackaged`.
 * @param options.resourcesPath - `process.resourcesPath` when packaged.
 * @param options.moduleUrl - `import.meta.url` of the main module.
 * @returns node + args + patch.
 */
export function resolveDesktopRuntime(options: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly moduleUrl: string
}): DesktopRuntimePaths {
  if (options.packaged) {
    const node = process.platform === 'win32'
      ? join(options.resourcesPath, 'node', 'node.exe')
      : join(options.resourcesPath, 'node', 'bin', 'node')
    const dsh = join(options.resourcesPath, 'dsh', 'lib', 'bin.js')
    const patch = join(options.resourcesPath, 'cordis.patch.yml')
    return { node, args: [dsh, ...webHostArgs(patch)], patch }
  }
  const here = dirname(fileURLToPath(options.moduleUrl))
  const repoRoot = join(here, '..', '..', '..')
  const bin = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')
  const patch = join(here, '..', 'cordis.patch.yml')
  const node = process.env.DSH_NODE
    ?? process.env.npm_node_execpath
    ?? process.execPath
  const tsx = pathToFileURL(join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
  return {
    node,
    args: ['--import', tsx, bin, ...webHostArgs(patch)],
    patch,
    workspaceRoot: repoRoot,
  }
}

/**
 * True when the resolved Node looks like Electron (cannot boot dsh).
 * @param node - candidate executable.
 * @returns whether the path basename starts with Electron.
 */
export function isElectronExecutable(node: string): boolean {
  return /(?:^|[/\\])electron(?:\.exe)?$/i.test(node)
}
