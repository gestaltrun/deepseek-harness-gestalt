# Agent Note: 托管 mobilecli 环境

状态：已实现

[English](2026-08-31-managed-mobilecli-environment.md) | 中文

## 问题

Desktop 只有在运维方提供 mobilecli 可执行文件时才能组合手机能力。全新安装因此只能呈现无法继续的缺失态，后续安装还需要重新挂载生命周期 owner 或重启 Desktop。下载可执行文件也引入供应链、文件系统与许可义务，这些都不属于 fleet Service。

## 决策

`phone-environment` 持有完整运行时快照、可信准备，以及显式 override、托管 current、系统发现的运行时选择顺序。Desktop 始终组合 environment、稳定 fleet、stream 与 tool Consumer。fleet 以 deferred 方式启动；只有持久化手机 gate 已启用时，environment 才会就地激活已选可执行文件。

托管准备只接受清单中六个固定的 mobile-next/mobilecli 1.0.5 GitHub Release asset；每项记录准确 URL、字节长度、SHA-256 摘要、Host tuple 与可执行文件名。流程只跟随 GitHub release-asset host，写入 owner-only staging 目录，校验流式长度与摘要，只接受 zip 根目录中的单个条目，探测可执行文件版本，并原子替换相对 `current.json` 指针。取消或失败会删除 staging，并保留此前 current generation。该操作绝不修改全局 npm 状态或 `PATH`。

浏览器通过共享同源信任栅栏保护的 Host 路由读取全量快照，并调用准备、取消或刷新。Android 与 iOS 平台行使用独立可扩展状态。非 macOS 的 iOS 行报告不支持，且不存在可执行操作。

mobilecli 使用 FSL-1.1，并带 Apache-2.0 future license。运行时从上游 Release 直接下载不等于本仓库随包分发或再分发，但也不等于获得法务许可。在法务或上游许可方确认预期产品用途获准之前，Desktop 发布仍保持阻塞。

## 考虑过的替代方案

**随包携带或 vendor mobilecli。** 拒绝，因为这会扩大再分发与发布许可风险，并且不再是上游原样下载。

**使用 npm 全局安装 mobilecli。** 拒绝，因为产品准备不应要求管理员权限、修改用户 shell 环境，或依赖用户维护的全局工具链。

**准备后重启 Desktop。** 拒绝，因为稳定 fleet 已持有 generation 替换能力，可以停止旧 IO 并激活已校验可执行文件，而不替换 Consumer 身份。

## 后果

全新 Desktop 可以从「手机设备」设置页进入托管运行时，无需手动安装或重启。启用、关闭、取消、替换与 teardown 状态共用同一套 child 与 IO ownership。平台专用 SDK 与模拟器准备仍归 Android 和 iOS environment 包。即使全部技术 gate 通过，FSL-1.1 产品用途决策仍是明确的发布阻塞项。
