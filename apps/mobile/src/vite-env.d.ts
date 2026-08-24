/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM_ORIGIN?: string
  readonly VITE_PLATFORM_CALLBACK_URL?: string
  readonly VITE_PLATFORM_GITHUB_CLIENT_ID?: string
  readonly VITE_PLATFORM_CREDENTIAL_REFERENCE?: string
  readonly VITE_PLATFORM_DATABASE_IDENTITY?: string
  readonly VITE_PLATFORM_IDENTITY_NAMESPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
