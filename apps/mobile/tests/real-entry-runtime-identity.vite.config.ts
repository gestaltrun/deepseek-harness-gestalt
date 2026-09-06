import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { OPERATED_PLATFORM_BUILD_ENV } from './fixtures/operated-platform-environment.fixture.ts'

const MAIN = fileURLToPath(new URL('../src/main.tsx', import.meta.url))
const PROTECTED_STORAGE = fileURLToPath(new URL('./fixtures/real-entry-protected-storage.fixture.ts', import.meta.url))

const runtimeIdentity = `${JSON.stringify({
  version: 1,
  origin: OPERATED_PLATFORM_BUILD_ENV.VITE_PLATFORM_ORIGIN,
  callbackUrl: OPERATED_PLATFORM_BUILD_ENV.VITE_PLATFORM_CALLBACK_URL,
  githubClientId: OPERATED_PLATFORM_BUILD_ENV.VITE_PLATFORM_GITHUB_CLIENT_ID,
  credentialReference: OPERATED_PLATFORM_BUILD_ENV.VITE_PLATFORM_CREDENTIAL_REFERENCE,
  databaseIdentity: OPERATED_PLATFORM_BUILD_ENV.VITE_PLATFORM_DATABASE_IDENTITY,
  identityNamespace: OPERATED_PLATFORM_BUILD_ENV.VITE_PLATFORM_IDENTITY_NAMESPACE,
})}\n`

function realEntryProtectedStorageFixture(): Plugin {
  return {
    name: 'dsh-mobile-real-entry-protected-storage-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      return source === './native-protected-storage.ts' && importer === MAIN ? PROTECTED_STORAGE : null
    },
    transform(code, id) {
      if (id !== MAIN) return null
      return code
        .replace('const environment = loadMobilePlatformEnvironment(await loadPackagedMobileRuntimeIdentity())', "const environment = loadMobilePlatformEnvironment(await loadPackagedMobileRuntimeIdentity()); document.documentElement.dataset.mobileRuntimeOrigin = environment.origin")
        .replace('const presentation = mobileInstallationPresentation(await Device.getInfo())', "const presentation = mobileInstallationPresentation({ platform: 'android', model: 'Snapshot Phone', operatingSystem: 'android', osVersion: '14' })")
    },
  }
}

function operatedRuntimeIdentityFixture(): Plugin {
  return {
    name: 'dsh-mobile-operated-runtime-identity-fixture',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'dsh-mobile-runtime-identity.json', source: runtimeIdentity })
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [
    realEntryProtectedStorageFixture(),
    operatedRuntimeIdentityFixture(),
    react(),
    tsconfigPaths({ projects: [fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url))] }),
  ],
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome83' },
})
