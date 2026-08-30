/**
 * Physical files for a loader-delivered browser plugin. The HTTP module host
 * serves these CommonJS factories through its stable `/client.js` route.
 */
export const DYNAMIC_CLIENT_ARTIFACT = {
  entryFileName: 'client.cjs',
  exportPath: './lib/client.cjs',
  relativePath: 'lib/client.cjs',
  sourceMapPath: 'lib/client.cjs.map',
} as const
