# Agent Note: 实例化 iOS protected-storage bridge controller

Status: implemented

[English](2026-08-25-ios-storyboard-registers-protected-storage.md) | 中文

## 问题

iOS storyboard 实例化了 Capacitor 的通用 `CAPBridgeViewController`。因此 application-specific `GestaltBridgeViewController.capacitorDidLoad()` hook 从未运行，`GestaltProtectedStorage` 没有注册，JavaScript startup 会无限等待第一次 protected Installation id read。即使 native application 与 bundled asset 已启动，Simulator 仍只显示空白 WebView。

## 决策

`Main.storyboard` 从 `App` module 实例化 `GestaltBridgeViewController`。该 controller 继续作为 `GestaltProtectedStorage` 的唯一 iOS registration owner；JavaScript entry 仍然要求这个 plugin，且不会 fallback 到未保护的 browser storage。

在验证 Keychain 时，Simulator build 使用正常的 local ad-hoc signing。关闭 code signing 不是有效的 protected-storage evidence，因为 unsigned process 无法建立 application Keychain entitlement context。

## 考虑过的替代方案

**从 JavaScript 注册 plugin。** 拒绝，因为 Capacitor native plugin registration 属于 native bridge lifecycle，JavaScript 无法创建缺失的 Swift implementation。

**plugin 缺失时 fallback 到 IndexedDB。** 拒绝，因为 shipped native entry 要求由 operating system 保护 Installation 与 pairing authority；browser fallback 会静默改变产品 security state。

**保留通用 controller，再增加一个 storyboard callback。** 拒绝，因为现有 application controller 已经拥有 Capacitor registration，并让 storyboard 只有一个明确的 root-controller identity。

## 后果

全新的 signed iOS Simulator installation 会在 Web entry 请求 Installation id 之前注册 protected storage，并到达 Account surface。缺失 native plugin 时仍然 fail closed。Storyboard class 和 module name 成为 release-critical native wiring，需要从 source 检查，不能从 Xcode compile success 推断。

## 测试

Release regression 要求 `Main.storyboard` 命名 `GestaltBridgeViewController` 与 `App` module，并拒绝通用 Capacitor controller。Clean signed Simulator build 会返回 Keychain result，并从 bundled Mobile asset 渲染真实 privacy 与 GitHub login flow。
