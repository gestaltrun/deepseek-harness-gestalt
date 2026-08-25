# Agent Note: iOS 受保护存储保留空结果对象

Status: implemented

[English](2026-08-25-ios-protected-storage-empty-result.md) | 中文

## 问题

原生受保护存储接口返回带可选 `value` 的对象。Android 在值不存在时返回空对象，而 iOS 在没有返回值的情况下结束 Capacitor 调用。因此首次安装的 iOS 会收到 `undefined`，产品启动会在已退出登录的账号界面渲染前失败。

## 决策

iOS Keychain 的未找到分支返回空 dictionary。两个原生实现现在都会在值缺失时保留共享的 `{ value?: string }` 结果类型，使 JavaScript owner 能够创建并持久保存第一份 Installation id。

## 已考虑的替代方案

**让 JavaScript 适配器接受 `undefined`。** 已拒绝，因为两个原生 bridge 应实现同一种结果类型，放宽适配器会掩盖另一处原生约定不一致。

**在原生代码中创建 Installation id。** 已拒绝，因为共享 JavaScript owner 定义了两个平台的 Installation 创建与持久化语义。

## 后果

首次安装的 iOS 可以进入账号界面，同时不会弱化 Keychain 失败处理。除 item 不存在以外的错误仍会明确拒绝。

## 测试

原生 shell 源码级回归会拒绝 iOS 未找到分支的无参数 resolve。使用生产配置打包的应用会在全新的 iOS Simulator 中构建、安装，并且必须渲染已退出登录的账号界面。
