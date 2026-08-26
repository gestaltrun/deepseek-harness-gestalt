# Agent Note: Windows NSIS update feed is a packaging check

Status: implemented

[English](2026-08-26-windows-nsis-update-feed-ci.md) | 中文

## Problem

DeepSeek Gestalt 0.1.6 发布了 240 MB 的 Windows NSIS 安装包和对应的 `latest.yml`。已安装的 0.1.5 客户端发现了该版本，但未能替换 electron-updater 缓存里的 `installer.exe`。Desktop Release 当时已经通过：pack-win 只 smoke `win-unpacked`，`release-assets.mjs` 只要求 `latest.yml` 存在并声明包版本。它从不对 NSIS 字节做哈希、从不通过 HTTP 拉取 feed、也从不运行安装器。打包 smoke 设置 `DSH_DESKTOP_SMOKE=1`，在 updater 启动之前就返回。

GitHub 通过短时签名 URL 从 `release-assets.githubusercontent.com` 提供 Release 资产。electron-updater 的 NsisUpdater 先尝试 differential 下载（Range 请求会跟随这些重定向），失败后再对 240 MB 的 exe 做一次完整 GET。60 秒空闲 HTTP 超时，以及不可达或过慢的 CDN，都会中止这次 GET。0.1.5 安装包是 175 MB，在同一条链路上可以下完；0.1.6 不能。托管的 Windows runner 在 GitHub 的快速网络上，即使它们下载已发布的 exe，也看不到 CDN 失败。

## Decision

pack-win 把 NSIS 安装包当作 Windows 更新产物。electron-builder 写入 `apps/desktop/release` 之后，`verify-windows-update-feed.mjs` 要求 `latest.yml` 的 `path`、`files.url`、`files.size` 和 `sha512` 与 `DeepSeekGestalt-Setup-<version>-x64.exe` 一致，然后在 loopback 上提供该目录，并按 electron-updater 先读 `latest.yml` 再取 exe 的方式下载 feed。随后作业用 `/S /D=` 把 NSIS 包静默装进 `$RUNNER_TEMP/gestalt-nsis`，并对已安装的 `DeepSeek Gestalt.exe` 做 smoke，同时保留 unpacked smoke。

打包后的 Desktop Host 在 electron-updater 上设置 `disableDifferentialDownload` 和 `disableWebInstaller`，并把 updater 日志追加到 `<userData>/logs/updater.log`。关闭 differential 是因为 GitHub 302 到签名 CDN 时会丢弃或忽略 Range 请求；客户端始终完整下载 NSIS 安装包。

无法给已经装上的 0.1.5 客户端打补丁去改 GitHub provider 或 HTTP 栈。那些客户端通过浏览器下载并运行 NSIS 安装包来安装 0.1.6。之后的包继承 feed 校验、NSIS smoke 和完整下载 updater。

## Alternatives considered

**只保留 unpacked smoke，再加安装包体积上限。** 字节上限本可以拦住 0.1.6 的 240 MB 安装包，但不能证明 `latest.yml` 的 sha512、HTTP feed 拉取或 NSIS 解包。feed 校验器和静默安装直接覆盖这些路径。

**在 `app-update.yml` 里把 Windows 安装包放到非 GitHub CDN。** 0.1.5 已经把 electron-updater 的 GitHub provider 钉在 `BeiKeJieDeLiuLangMao/deepseek-harness-gestalt`。改 provider 需要新的 Desktop Bundle，因此不能给已安装的 0.1.5 客户端解困。Personal Release Channel 仍是 GitHub Releases。

**把 0.1.5 的 blockmap 上传到 0.1.6 GitHub Release，好让 differential 跑起来。** 这会改动已发布的 Release，并且仍然依赖针对签名 CDN 的 GitHub Range 请求。完整 NSIS 下载才是受支持的 Windows 路径。

## Consequences

Desktop Release 的 pack-win 会多一次 NSIS 静默安装和一次对安装包的 loopback 下载。unpacked smoke 仍是更快的启动检查。之后版本的 updater 失败会在 userData 下留下日志。特定 Windows 网络能否访问 GitHub CDN 仍在 CI 之外；feed 检查会在发布前抓住不匹配或不完整的 NSIS 产物。

## Testing

`apps/desktop/tests/verify-windows-update-feed.spec.ts` 拒绝 sha512、path 和 size 漂移，并在 loopback 上下载夹具 feed。`apps/desktop/tests/release-workflow.spec.ts` 要求在上传 artifact 之前运行 feed 校验器和 NSIS 静默安装 smoke。`apps/desktop/tests/updater.spec.ts` 固定 `disableDifferentialDownload`、`disableWebInstaller` 和磁盘日志。
