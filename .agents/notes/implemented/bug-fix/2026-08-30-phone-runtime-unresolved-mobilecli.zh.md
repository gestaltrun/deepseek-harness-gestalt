# Agent Note: mobilecli 不可解析时保持 Host 组合

Status: implemented

[English](2026-08-30-phone-runtime-unresolved-mobilecli.md) | 中文

## Problem

Desktop 与浏览器组合把 `phone-runtime` 作为可选设备群提供方挂载。Electron GUI 进程自带极简 `PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`），HOME 下的 npx 缓存也常为空，因此即使用户已全局安装 npm 包，`mobilecli` 仍经常不可解析。插件构造期抛错会在任何 URL 宣布之前拖垮整个 Web Host，会话面装不起来，安装指引也到不了「手机」tab。

## Decision

`PhoneDevices` 仍在构造函数里解析可执行文件，但不可解析时不再抛错。Service 照常激活、跳过子进程，所有公开操作（`listDevices`、`boot`、`shutdown`、`io`、`startCapture`、`agentStatus`、`installAgent`）以携带 `mobilecliInstallGuidance` 的 `PHONE_UNRESOLVED` 拒绝。发现顺序为 `executablePath`，然后 `PATH`，然后 npm 全局（`~/.npm-global/bin`、`~/.local/bin`、Windows `%APPDATA%\npm`）、npx 缓存（`~/.npm/_npx/*/node_modules/.bin`）和 `npm_config_prefix`。Electron 极简 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`）还会探测 `/opt/homebrew/bin` 与 `/usr/local/bin`。`GET /phone/devices` 以 502 返回 `{ error: { code: 'PHONE_UNRESOLVED', message } }`。选择器与设置卡把它渲染为「未找到 mobilecli」并给出 `npm install -g mobilecli@latest`。Desktop overlay-boot spec 用指向缺失路径的 `DSH_PHONE_MOBILECLI` 挂上 phone 行，再断言 URL 宣布、HTTP 200 以及该 502 体。

这修正了[mobilecli 提供方笔记](../feature/2026-08-27-phone-runtime-mobilecli-provider.zh.md)：组合期抛错留给二进制已解析后的坏子进程；缺失二进制是不可用的设备群，不是死掉的 Host。

## Alternatives considered

**继续在组合期抛错。** 否决：叠加层与 web-app roster 共用一个进程；缺失的可选二进制不得中止 URL 宣布。

**清单 502 仍用泛化的 `upstream` 代码。** 否决：tab 的错误臂需要结构化代码和安装行，而不是 `phone device listing failed with HTTP 502`。

**只搜 `PATH`。** 否决：Electron 的极简 PATH 会藏起用户的 npm 全局安装；额外前缀只为该 GUI 进程存在。

## Consequences

静默空清单仍然禁止：运维仍能看见安装指引，只是改到「手机」tab 与设置卡上，而不是死掉的 Host。配置了但不指向可执行文件的 `executablePath` 走同一条 `PHONE_UNRESOLVED` 臂。其他启动失败（就绪前子进程退出）仍拒绝插件初始化。Desktop 的 phone 行仍由 `DSH_PHONE_MOBILECLI` opt-in；overlay-boot 臂把该环境变量设为缺失路径，以便测的就是不可解析这一支。
