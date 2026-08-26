# Agent Note: Windows NSIS update feed is a packaging check

Status: implemented

English | [中文](2026-08-26-windows-nsis-update-feed-ci.zh.md)

## Problem

DeepSeek Gestalt 0.1.6 published a 240 MB Windows NSIS installer and a matching `latest.yml`. Installed 0.1.5 clients discovered that release, then failed to replace `installer.exe` in the electron-updater cache. Desktop Release had already passed: pack-win smoked `win-unpacked`, and `release-assets.mjs` only required `latest.yml` to exist and declare the bundle version. It never hashed the NSIS bytes, never fetched the feed over HTTP, and never ran the installer. Packaged smoke sets `DSH_DESKTOP_SMOKE=1` and returns before the updater starts.

GitHub serves release assets from `release-assets.githubusercontent.com` through short-lived signed URLs. electron-updater's NsisUpdater first tries a differential download whose Range requests follow those redirects, then falls back to one full GET of the 240 MB exe. A 60 s idle HTTP timeout and an unreachable or slow CDN both abort that GET. The 0.1.5 installer was 175 MB and could finish on the same link; 0.1.6 did not. Hosted Windows runners are on a fast GitHub network, so they would not have seen the CDN failure even if they had downloaded the published exe.

## Decision

Pack-win treats the NSIS installer as the Windows update artifact. After electron-builder writes `apps/desktop/release`, `verify-windows-update-feed.mjs` requires `latest.yml` `path`, `files.url`, `files.size`, and `sha512` to match `DeepSeekGestalt-Setup-<version>-x64.exe`, then serves that directory on loopback and downloads the feed the same way electron-updater reads `latest.yml` then the exe. The job then silent-installs the NSIS package with `/S /D=` into `$RUNNER_TEMP/gestalt-nsis` and smokes that installed `DeepSeek Gestalt.exe`, in addition to the unpacked smoke.

Packaged Desktop Host sets `disableDifferentialDownload` and `disableWebInstaller` on electron-updater and appends updater logs at `<userData>/logs/updater.log`. Differential downloads stay off because GitHub's 302 to the signed CDN drops or ignores Range requests; the client always fetches the full NSIS installer.

The 0.1.5 GitHub provider and HTTP stack cannot be patched in already-installed apps. Those clients install 0.1.6 by running the NSIS installer from a browser download. Later bundles inherit the feed check, NSIS smoke, and full-download updater.

## Alternatives considered

**Keep unpack-only smoke and add a size ceiling.** A byte cap would have failed 0.1.6's 240 MB installer, but it would not prove `latest.yml` sha512, HTTP feed fetch, or NSIS extract. The feed verifier and silent install cover those paths directly.

**Host Windows installers on a non-GitHub CDN in `app-update.yml`.** 0.1.5 already pins electron-updater's GitHub provider to `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt`. Changing the provider requires a new Desktop Bundle, so it does not unblock installed 0.1.5 clients. The Personal Release Channel remains GitHub Releases.

**Upload the 0.1.5 blockmap onto the 0.1.6 GitHub Release so differential can run.** That mutates a published release and still depends on GitHub Range requests against the signed CDN. Full NSIS download is the supported Windows path.

## Consequences

Desktop Release pack-win is slower by one NSIS silent install and one loopback download of the installer. Unpack smoke remains the faster boot check. Updater failures on later bundles leave a log under userData. GitHub CDN reachability from a given Windows network is still outside CI; the feed check catches a mismatched or incomplete NSIS artifact before publish.

## Testing

`apps/desktop/tests/verify-windows-update-feed.spec.ts` rejects sha512, path, and size drift and downloads a fixture feed over loopback. `apps/desktop/tests/release-workflow.spec.ts` requires the feed verifier and NSIS silent-install smoke before artifact upload. `apps/desktop/tests/updater.spec.ts` pins `disableDifferentialDownload`, `disableWebInstaller`, and the on-disk log.
