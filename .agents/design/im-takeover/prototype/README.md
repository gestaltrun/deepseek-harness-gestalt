# IM takeover accepted prototype

English | [中文](README.zh.md)

Self-contained React/Vite prototype of the accepted IM takeover design. It runs entirely on in-memory demo data: no real IM connection, no real authentication, no credential storage.

## Run

Prerequisite: the formal application checkout must exist at the absolute path referenced by `prototype/package.json` (`file:` dependency on `@deepseek-ai/dsh-client-ui-primitives`), or adjust that path to a local equivalent. This prototype is not portable to machines without that application install.

```sh
cd .agents/design/im-takeover/prototype
npm install    # first run generates a local package-lock.json for this location
npm run dev    # http://127.0.0.1:5174/
```

No lockfile is committed: npm records `file:` links relative to the directory depth of the checkout, so a committed lock breaks when the archive is copied elsewhere. Use `npm install`, never `npm ci`. `npm run build` verifies the bundle compiles.

## Provenance

Formal UI primitives are imported directly from the installed application; theme token snapshots live in `system/tokens/` with source hashes in `manifest.json`. Shell chrome is reconstructed from formal screenshots and marked as such in `manifest.json` — pixel-identity is not claimed. `HASHES.sha256` verifies the sanitized file set of this archive; private formal-GUI reference captures are deliberately excluded.
