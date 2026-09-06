import { loadEnv, type Plugin } from 'vite'
import { loadMobilePlatformEnvironment } from './src/platform-environment.ts'

const RUNTIME_IDENTITY_FILE = 'dsh-mobile-runtime-identity.json'

/** Serve and package the single Platform identity consumed by Mobile boot. */
export function mobileRuntimeIdentity(): Plugin {
  let content = ''
  return {
    name: 'dsh-mobile-runtime-identity',
    configResolved(config) {
      const source = { ...loadEnv(config.mode, config.root, ''), ...process.env }
      const environment = loadMobilePlatformEnvironment(source)
      content = `${JSON.stringify({
        version: 1,
        origin: environment.origin,
        callbackUrl: environment.callbackUrl,
        githubClientId: environment.githubClientId,
        credentialReference: environment.credentialReference,
        databaseIdentity: environment.databaseIdentity,
        identityNamespace: environment.identityNamespace,
      })}\n`
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== `/${RUNTIME_IDENTITY_FILE}`) {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.end(content)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: RUNTIME_IDENTITY_FILE, source: content })
    },
  }
}
