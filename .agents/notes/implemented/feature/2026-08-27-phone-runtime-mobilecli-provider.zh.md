# Agent Note: mobilecli 手机设备群 Service

状态：已实现

[English](2026-08-27-phone-runtime-mobilecli-provider.md) | 中文

## 问题

移动设备 dock（#355）需要 Host 侧回答“本机有哪些手机硬件、如何 boot/shutdown 一台设备”。Host 已通过可替换 seam 支持浏览器，但手机侧一片空白：在各 Consumer 里直接脚本化 `adb`/`xcrun` 会把按操作系统划分的设备逻辑复制到每个调用方，而直连 adb 的捷径会把 Android 传输层硬连进 Host。

## 决策

`packages/phone/phone-runtime`（@deepseek-ai/dsh-phone-runtime）是承载于 `ctx.phoneDevices` 的手机设备群 Service；由于 mobilecli 是当下唯一可想象的 backend，Service Definition 与 Service Provider 折叠进同一个包（[capability seams](../../../../docs/glossary.zh.md#capability-seam) 允许折叠；Consumer 仍另置他处）。Service：

- 以 `server start --listen 127.0.0.1:<serverPort>` 启动用户安装的 `mobilecli`，环境为去除凭据的父环境——绝不 vendor、拷贝或 shell 出 adb；一切设备事实都经过上游 OpenRPC JSON-RPC 契约（`devices.list`、`device.boot`、`device.shutdown`、`server.info`，以及面向 Consumer 的 `device.io.*` 与 `device.screencapture`）或 PNG 静帧 CLI（`screenshot --format png`）；
- 探测就绪（`server.info`），随后以 `includeOffline: true` 轮询 `devices.list`，让已关机的模拟器保持可见的 boot 目标；`online` 映射自上游 `state` 字段，`kind` 映射自上游 `type` 字段（`emulator`/`simulator`/`real`，其余一律响亮的 `PHONE_PROTOCOL`）；
- 仅在真实差异时发布分组清单 `{ android, ios: { simulators, reals } }`，并以精确的 added/removed id 差值通知 `onChanged` 订阅者；该关系由本包的 invariant 伴生插件在运行时强制（发布前对照已发布清单重推差异）；
- 在任何 RPC 之前于本包内拒绝真机的 `boot`/`shutdown`，镜像上游仅限模拟器的限制；
- 激活后每一阶段都响亮失败：二进制不可解析仍会激活 Service，此后一切操作以 `PHONE_UNRESOLVED` 拒绝并附带安装指引（`npm install -g mobilecli@latest`；上游没有 brew formula），而不是拖垮 Host 组合（[缺失二进制优雅降级](../bug-fix/2026-08-30-phone-runtime-unresolved-mobilecli.zh.md)）；就绪前子进程退出令插件初始化拒绝；就绪后的失联（退出、拒连、协议违背、invariant 违背）将 Service 置为 lost，后续操作以记录的原因拒绝。

部署相关旋钮是经校验的 Config 字段（`executablePath`、`serverPort`——上游默认 12000、`pollIntervalMs`、`readyTimeoutMs`、`requestTimeoutMs`——上游 RPC 超时、`bootTimeoutMs`——上游扩展 boot 截止）。所有操作将调用方 `AbortSignal` 与这些上限融合，并把一切失败归一到 `PhoneDevicesError` 携带的封闭 `PhoneErrorCode` 联合。

## Alternatives considered

**Host 直连 adb/xcrun。** 否决：这会重新实现 mobilecli 的设备聚合（按 OS 的传输、状态归一、远程设备群），并把 Android 工具硬连进 Host 代码，dock 为 iOS 还得再分叉一次。

**现在就拆分 Definition/Provider 两包。** 否决，为时过早：只有一个 backend 时，拆分只会复制 seam 笔记警示的 manifest/tsconfig 样板；`ctx.phoneDevices` 键与词表已把 Consumer 与折叠实现隔离。

**无 mobilecli 时静默空清单。** 否决：静默的空设备列表比响亮的安装错误更糟；本包的价值就是可信的设备群事实，“没有二进制”是运维必须看见的部署错误。组合本身不再抛错——见[不可解析二进制笔记](../bug-fix/2026-08-30-phone-runtime-unresolved-mobilecli.zh.md)——因为为可选提供方拖垮 Host 会把指引一并藏掉。

## Consequences

延迟 Consumer [`dsh-tool-phone`](2026-08-28-tool-phone-deferred-device-tools.zh.md) 获得面向双平台、以 branded id 寻址的单一表面，可以带变更通知地 boot/shutdown 模拟器；但也继承硬性的用户前置：必须安装 mobilecli（npm/源码）且其平台前置（adb、Xcode CLT）在场。`io`、`startCapture` 与 `screenshot` 是给 Host Consumer（例如[同源流通道](../architecture/2026-08-28-phone-same-origin-stream-channel.zh.md)）追加的 Service 方法；它们不改变清单或生命周期语义。`screenshot` 通过 `mobilecli screenshot --format png` 返回一张 PNG 静帧。外部依赖保持 FSL-1.1-Apache-2.0 的安全距离——只执行、绝不 vendor——行为随安装版本走；本包只锚定其校验的 OpenRPC 方法名与线上形状。套件以脚本化的 `fakemobilecli` JSON-RPC 替身无密钥运行；唯一 staging authority 在同一 fake 模块上生成无扩展名 POSIX 可执行文件，或生成指向当前 Node 可执行文件的 Windows `fakemobilecli.exe` 符号链接，因此原生 Windows coverage 会经过生产解析器、进程持有者与生命周期断言，不引入仅供测试的生产路径。
