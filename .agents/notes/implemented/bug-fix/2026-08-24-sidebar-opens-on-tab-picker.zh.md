# Agent Note: 侧栏打开时展示标签类型选择

Status: implemented

[English](2026-08-24-sidebar-opens-on-tab-picker.md) | 中文

## Problem

新 Session 会在侧栏中预置一个无路径 `editor` 标签，其标题使用英文常量 `Files`。`+` 菜单还会按当前语言独立提供同一个 `editor` 类型，而无路径 editor 按设计没有去重键。因此，选择本地化的「文件」选项会为同一页面创建第二个标签。语言选择通过不同文案暴露了两种来源，但不是重复创建的原因。

## Decision

新 Session 状态只包含一个空 pane。既有空 pane 卡片使用与 `+` 菜单相同的注册表数据渲染所有已启用标签类型，选择卡片会通过普通服务路径打开该类型。

布局清理会移除旧默认值产生的自动 Files home。该记录通过完整的自有特征识别：`editor` 类型、英文 `Files` 标题、无路径、生成的 `tab:<number>` id，以及对象类型的元数据。用户自建 Files home 使用稳定的 `editor` id，已打开文件则携带路径；两者都会继续持久化。

## Alternatives considered

**本地化自动标签标题。** 未采用，因为这只会隐藏文案差异，仍保留两个相互独立的入口和 Files 的隐式优先级。

**对所有无路径 editor 去重。** 未采用，因为去重会让显式 Files home 具有全局特殊性，也不会在首次打开时提供中立的类型选择。

**删除所有持久化的无路径 editor。** 未采用，因为这会删除用户从类型选择或 `+` 菜单显式打开的标签。

## Consequences

打开新侧栏时需要显式选择标签类型，所有已启用类型具有同等位置。加载既有布局时只会移除自动 Files 记录；显式 editor home 与文件标签都会保留。组件测试固定空白新状态、可见类型卡片和迁移判别条件。装配后的 Web replay 会对新选择器快照并通过 Side Chat 卡片打开标签。
