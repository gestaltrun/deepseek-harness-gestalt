# Agent Note: Phone-stream Android logicalDisplay 路由夹具

Status: implemented

[English](2026-09-05-phone-stream-android-logical-route-fixtures.md) | 中文

## 问题

Phone-stream 路由测试会铸造 Android 采集，并以解码后的 `captureWidth`/`captureHeight` 转发 tap JSON-RPC。Android 采集源 IO 需要当前 `logicalDisplay` 之后，清单夹具若未设置 dumpsys，这些测试会失败。清单为横屏尺寸时，若未 mock `openAndroidSystemH264`，还会启动 Host `adb screenrecord`。

## 决定

`packages/phone/phone-stream/tests/routes.spec.ts` 仍默认把 `readAndroidLogicalDisplay` mock 为 `undefined`。tap JSON-RPC 用例设为 `{ width: 100, height: 200 }`，与解码源 100×200 对齐。live capture-size 用例设为 `{ width: 2868, height: 1320 }`，并继续断言 Host `io` 看到这些解码尺寸。对 `android-h264-process.ts` 的声明式 `vi.mock` 返回 `buildGradientH264()`，使横屏清单不会启动 host `adb`。生产代码不变。

## 考虑过的替代方案

**对 PhoneDevices 私有 `readAndroidLogicalDisplay` 做强制转换。** 拒绝：模块 mock 才是生产 listing 使用的同一缝。

**保持 dumpsys 未定义并期望 PHONE_PROTOCOL。** 拒绝：这些测试证明的是解码采集字段的 WebSocket 转发，不是缺 logical 的拒绝。

## 后果

基线 feature 在 dumpsys 缺失时仍保持绿色，仅这两处用例被装饰。后端合并后，同一夹具提供相容宽高比，采集 IO 可被接纳，且不改变解码平面断言。
