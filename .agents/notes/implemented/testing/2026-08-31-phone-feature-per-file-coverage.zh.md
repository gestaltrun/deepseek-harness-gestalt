# Agent Note: 手机功能逐文件覆盖率清单

Status: implemented

[English](2026-08-31-phone-feature-per-file-coverage.md) | 中文

## 问题

手机功能在 `phone-runtime`、`phone-stream` 与 `ui-phone` 中包含生命周期、传输、渲染及平台解析分支。仓库覆盖率门禁按源文件独立要求 100%，仅验证成功路径的交互测试无法覆盖陈旧 generation、无效画面尺寸、离线与未授权响应、resolver 失败和浏览器注册 wiring，因而会阻断交付。

## 决策

手机 package 的全部自有源文件保留在正常覆盖率清单中。归属测试覆盖 runtime 启停、可执行文件解析、publication invariant、设备列表与切换、H264 播放与画面所有权、连接 generation 与重试、capture proxy 取消与失败收敛、归一化输入映射、失败文案以及插件注册。保护终止状态、无效设备尺寸、进程故障或 wire 故障的防御分支具有明确的结果断言。封闭类型 union 与自有生命周期 invariant 不保留不可达的运行时分支。手机路径不使用 coverage exclusion、忽略区间、降低阈值或仅供测试的生产分支。

## 考虑过的替代方案

**排除浏览器与平台专属的手机文件。** 否决：既有传输、WebCodecs、文件系统与进程 seam 可以确定性验证这些行为；排除会隐藏已交付的生命周期路径。

**只调用 helper 而不检查结果，以此覆盖分支。** 否决：覆盖率清单必须保留每条分支背后的用户可见及生命周期义务，包括清理和终止状态行为。

## 后果

修改 `packages/phone/phone-runtime/src/**`、`packages/phone/phone-stream/src/**` 或 `packages/client/ui-phone/src/**` 时，每个新增 statement、function 与 branch 都需要对应的行为用例。平台专属 launcher 用例仍可按条件跳过，但共享源文件清单必须在支持的 coverage lane 中保持 100%。

## 验证

受支持的手机三分区清单运行 395 个测试，另有两个平台条件跳过；1,986 个 statements、1,101 个 branches、471 个 functions 与 1,732 行均为 100%。仓库 partitioned coverage lane 仍是合并权威。
