# Agent Note: 修正原生 Mobile 应用身份

Status: implemented

[English](2026-08-28-mobile-application-identity.md) | 中文

## Problem

预发布原生工程与发布 Environment 使用 `com.alibaba.gestalt.mobile`，但该应用在 Gestalt 产品 namespace 下分发。application identifier 还与 `Gestalt` 构建产品名称及`獭子哥`消费者名称相互漂移，因此一次发布可能在签署错误应用身份的同时通过展示品牌校验。

## Decision

`com.gestalt.mobile` 是唯一的 iOS bundle identifier 与 Android application id。Java package、受保护存储 service 名称、provisioning profile mapping、原生工程元数据、发布 Environment 与签名安装包检查都使用该 identifier。两个发布 job 都显式接收 `MOBILE_BUNDLE_ID`，并拒绝其他值，避免 Environment 元数据滞后于 script default。

Xcode `PRODUCT_NAME`、archive 与 package 文件名及 CI artifact identifier 使用 `Gestalt`。[消费者品牌决策](../feature/2026-08-28-tazige-mobile-brand.zh.md)继续拥有作为展示文案的`獭子哥`及作为视觉身份的已批准水獭。[原生容器决策](../architecture/2026-08-24-native-mobile-container-and-protected-authority.zh.md)继续拥有受保护存储、签名隔离与发布权限。

## Alternatives considered

**因预发布 build 已使用 `com.alibaba.gestalt.mobile` 而继续保留它。**不采用，因为这些候选包没有 App Store release 或受支持的 upgrade contract，且组织 namespace 不是已批准产品身份。

**在 bundle identifier 或构建产品中使用消费者名称。**不采用，因为`獭子哥`是展示文案，而反向域名 identifier 与构建 artifact 需要稳定技术名称。

**让每个 release script 在不读取 Environment 值的情况下自行采用 identifier default。**不采用，因为正确 default 会掩盖陈旧发布元数据，并让两个平台 job 校验不同输入。

## Verification

品牌测试检查每个原生 identifier 所有者，并要求两个发布 job 消费同一个 Environment variable。Android release 校验检查签名 APK 的 package name、version 与 launcher label。iOS release 校验在 export 前检查 archive application identifier、构建产品名称、展示名称、version、provisioning profile 与 signature。

## Consequences

identifier 变更会创建独立原生 Installation identity。`com.alibaba.gestalt.mobile` 候选包中的受保护配对状态不会迁移到 `com.gestalt.mobile`；用户需要重新配对新安装。除非 package metadata、provisioning profile、发布 Environment、构建身份与消费者展示身份一致，否则签名候选包不能进入外部 Beta 分发。
