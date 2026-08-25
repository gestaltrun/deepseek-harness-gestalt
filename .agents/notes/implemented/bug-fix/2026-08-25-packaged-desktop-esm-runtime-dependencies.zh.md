# Agent Note: 为 Electron 打包 Desktop ESM 运行时依赖

Status: implemented

[English](2026-08-25-packaged-desktop-esm-runtime-dependencies.md) | 中文

## 问题

打包后的 Desktop 主进程是 ESM bundle。把 CommonJS `ws` 包内联后，它对 Node 内置模块的动态 require 也进入 bundle；生成的 ESM require shim 会在 Desktop 日志、Account controller 或 Web Host 启动前拒绝这些调用。packaged 冒烟测试还替换了 macOS login home，使 Electron `safeStorage` 在用户 Keychain 有效时仍不可用；同时，测试会在 prompt 被接纳后立即搜索，而此时已接纳的 turn 仍在写入权威 Session log。

## 决策

Desktop 主进程构建把 `ws` 保留为外部依赖，并像现有 Electron 外部依赖一样将它声明为直接运行时依赖。由于生成的外部 import 不在 TypeScript 源码图中，Desktop 的 Knip workspace 会记录这项由打包过程拥有的依赖。packaged 冒烟测试在所有平台隔离 `DSH_HOME` 与 Electron userData，但保留已登录 macOS 用户的 home，使 `safeStorage` 使用 login Keychain。冒烟验收会先等待权威 `turn/end` 事件，再执行 Session 搜索；使用生产配置时，pairing 会报告 `ready`。

## 已考虑的替代方案

**向 ESM bundle 注入通用 `createRequire` shim。** 已拒绝，因为这会掩盖具体哪个 CommonJS 包需要 Node 运行时加载，并让所有内联动态 require 都成为 Desktop loader policy 的一部分。

**增加明文或仅测试使用的受保护存储 fallback。** 已拒绝，因为 packaged 验收会使用 Electron `safeStorage`，并保留与安装产品相同的失败行为。

**增加固定延迟或重试搜索结果。** 已拒绝，因为 prompt 接纳不能证明 turn 已完成；Session log 的 `turn/end` 事件才是权威生命周期事实。

## 后果

打包应用会从已安装的运行时依赖加载 `ws`，而不是在 ESM bundle 中执行 CommonJS 源码。macOS packaged 测试在不复用应用状态的情况下保留 Keychain 访问能力，其他平台仍使用临时 home。冒烟测试只有在权威前置状态可见后，才会继续验证 Account、Pairing、Web Host、Companion prompt、SQLite 搜索、Relay teardown 与 quit。

## 测试

bundle 回归要求外部 `ws` import，拒绝内联的 `ws` 源码，并要求直接运行时依赖。使用生产配置的 macOS arm64 packaged 冒烟测试会在没有运行时 Platform 或 Relay 变量的情况下启动安装 bundle，等待 `turn/end`，验证搜索命中与未命中结果，并完成 Relay 生命周期与关闭检查。
