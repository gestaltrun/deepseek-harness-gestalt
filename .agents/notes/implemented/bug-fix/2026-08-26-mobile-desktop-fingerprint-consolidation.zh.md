# Agent Note: 合并重新配对的 Desktop Authority

Status: implemented

[English](2026-08-26-mobile-desktop-fingerprint-consolidation.md) | 中文

## 问题

Electron dev 与打包 Desktop 使用独立的 installation record。在同一台电脑上分别配对两个副本，会让 Mobile 获得两条 Desktop 名称相同的有效 Personal Pairing，因此 Paired Desktop selector 会展示重复行并保留重复 authority。

## 决策

账号隔离的 Mobile pairing vault 会对已鉴权 Desktop 名称执行 Unicode NFKC 规范化、去除首尾空白并忽略大小写，把结果作为简单设备 fingerprint。当当前选中且已鉴权的 pairing 与旧 retained pairing 匹配时，Mobile controller 会使用新的 installation proof 撤销每条旧 Platform pairing，然后才释放其本地密钥并移除对应行。Platform 撤销失败时会保留旧 authority，以供重试，而不会隐藏它。

## 考虑过的替代方案

**在 React 中隐藏重复行。** 拒绝，因为旧 Platform principal 与本地 pairing key 仍然有效，却会变得不可见。

**在撤销 Platform pairing 前删除本地重复密钥。** 拒绝，因为网络失败会留下有效 Platform authority，而本地已没有重试 cleanup 所需的 identity。

**采集硬件序列号。** 拒绝，因为这个预发布 Desktop flow 只需要本地产品提示，不足以证明应采集更强的跨 installation 硬件 identifier。

## 后果

同名 Desktop 重新配对后，会在已鉴权前台同步完成时替换旧 authority。刻意配置为同一个规范化名称的不同电脑会被视为同一台 Desktop；若要支持这种情况，未来需要在经过隐私评审后，通过加密 Companion projection 传递随机设备 identifier。

## 测试

Key-vault coverage 证明规范化会发现但不会擦除旧 pairing。Controller coverage 证明 Platform 撤销先于本地密钥释放，且发布的 selector 只保留当前 pairing。
