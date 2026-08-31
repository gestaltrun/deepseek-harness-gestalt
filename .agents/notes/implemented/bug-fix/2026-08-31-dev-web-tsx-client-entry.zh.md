# Agent Note: 显式声明开发态 client 入口

Status: implemented

[English](2026-08-31-dev-web-tsx-client-entry.md) | 中文

## 问题

共享 client bundle preset 为开发 watcher 选择 `src/client/index.ts`，为完整 Client build 选择 `lib/types/client/index.js`。源码入口为 TSX 的包可以通过完整 build，却只在 `pnpm run dev:web` 下失败：tsdown 返回其 watcher bundle，但初始 build 不完成，导致 HMR（热模块替换）就绪栅栏无限等待。

## 决策

`clientBundle()` 接受可选的开发态 `clientSourceEntry`，并保留 `src/client/index.ts` 作为默认值。产物 Client build 继续消费 `lib/types/client/index.js`。源码文件名不同的包在包配置调用处声明；`ui-phone` 声明 `src/client/index.tsx`。

HMR 就绪栅栏继续要求每个 tsdown bundle 完成初始 build。缺失或错误的源码入口仍是 build failure，不通过增加 timeout 或部分就绪状态隐藏。

## 考虑过的替代方案

**把 TSX 入口重命名为 `.ts`。** 否决：入口包含 JSX，TypeScript 要求使用 `.tsx` 扩展名。

**根据文件系统推断 `.ts` 或 `.tsx`。** 否决：包 build 输入应在包边界显式声明；推断还会把缺失入口的诊断推迟到启动时。

**放宽就绪栅栏。** 否决：在每个 plugin bundle 更新完成前启动 Vite，可能提供陈旧浏览器产物并造成 HMR 假绿。

## 后果

开发 watcher 与完整 Client build 可以使用不同的物理入口文件名，同时保留一处包属声明。新包在源码入口没有差异时继续使用默认值。preset 测试同时检查显式开发入口和固定产物入口。

## 验证

client bundle preset 测试覆盖显式 `.tsx` 源码入口与固定产物入口。真实 HMR 浏览器 E2E 通过要求每个 bundle 先进入就绪态来覆盖 `ui-phone` 调用处，随后编辑 client 源码、在不刷新页面的情况下观察更新，并恢复其自有源码与 build 产物。
