# Agent Note：原生文件选择结果保留到前台重新同步完成

状态：已实现

[English](2026-08-28-native-picker-foreground-resync.md) | 中文

## 问题

Android DocumentsUI 会在用户选择文件时把 Capacitor 应用切到后台。浏览器会在应用恢复前台期间返回已选 `File`，此时当前 Companion generation 可能尚未完成同步，mutation control 仍处于禁用状态。如果在这个时点丢弃 change event，一次已经成功完成的原生文件选择也会丢失。

## 决策

打开原生选择器仍然要求当前前台 mutation authority。mutation authority 暂时关闭时，Session browse owner 可以在组件内存中保留一个由浏览器返回的 `File`；前台同步恢复 authority 后，再通过普通 attachment callback 提交。这个 owner 可以跨原生前台恢复期间的 conversation detail 重挂载存活，会在提交前清除待处理引用，并在用户离开 conversation 或 Desktop 移除权威 Session 时释放该引用且不持久化。

attachment surface、当前 generation permit、加密上传和 Desktop 确认保持不变。Mobile 离线时，待处理选择不能开始上传、创建 operation id，也不能绕过前台 generation 检查。

## 已考虑的替代方案

- **忽略 mutation control 禁用期间返回的选择**——拒绝，因为原生选择器在正常 Android 前台恢复期间就会产生这种状态。
- **在没有当前 authority 时立即提交**——拒绝，因为 attachment authorization 与加密投递属于已同步的物理 generation。
- **跨导航或重启持久化所选字节**——拒绝，因为 attachment 字节不应进入 Companion Cache 或受保护的 pairing document。

## 后果

Android 原生文件选择可以跨越选择器引起的前台同步间隔。离开 conversation 会放弃尚未发送的选择，因此用户返回后需要重新选择文件。聚焦 presentation 覆盖会模拟选择器启动、禁用状态下交付 callback、authority 恢复与卸载清理；实际运行验收仍会验证原生选择器以及随后的 Desktop `session/attachment-admitted` event。
