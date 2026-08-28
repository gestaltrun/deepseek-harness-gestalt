# Agent Note: 受控 Mobile 发布验收使用完整链接配对

Status: implemented

[English](2026-08-28-link-only-mobile-release-acceptance.md) | 中文

## Problem

受控 Mobile 发布证明同时要求相机二维码扫描和完整链接配对，尽管两种输入都会进入同一个邀请解析器和配对握手。发布操作者选择在手机验收中使用完整链接，并排除相机硬件。若精确证据词表继续包含 `camera-pairing`，签名前就必须做出不真实的声明。

## Decision

`COMPANION_RELEASE_FLOWS` 要求 `link-pairing`，且不包含 `camera-pairing`。实际运行验收在 Android Emulator 和 iOS Simulator 上使用完整邀请链接。相机二维码扫描仍是受支持的产品能力，并保留现有组件和生命周期覆盖，但不再是 `Mobile Companion Acceptance` 或 Mobile 签名授权所需证据。

## Alternatives considered

**把完整链接验收报告为相机验收。** 不采用，因为不可变发布证据必须准确命名实际执行的流程。

**每次受控发布都要求两种配对输入。** 不采用，因为两种输入共享同一个解析器和握手，而相机权限与硬件会引入本次发布范围之外的独立设备条件。

**从产品中移除相机扫描。** 不采用，因为操作者缩小的是发布证据范围，而不是受支持的产品能力。

## Consequences

精确发布词表会把 `camera-pairing` 拒绝为未知值，同时仍会拒绝缺少 `link-pairing` 的证据。绑定旧候选提交的证明不能复用于新候选提交。产品相机行为、权限、清理和测试保持不变。发布评论和 issue 验收必须区分受支持的相机功能与仅使用链接的实际运行验收。
