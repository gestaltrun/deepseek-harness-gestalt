# Agent Note: 獭子哥 Mobile 品牌

Status: implemented

[English](2026-08-28-tazige-mobile-brand.md) | 中文

## Problem

Mobile Companion 的技术身份与消费者品牌都使用 DeepSeek Gestalt 标签。因此，已安装应用、原生启动器、浏览器标题、登录前页眉与商店记录都没有独立的用户身份，尽管该应用仍是 Paired Desktop 的一个访问界面。

## Decision

`獭子哥`是唯一面向消费者的应用名称，已批准的水獭是其视觉身份。iOS `CFBundleDisplayName`、Android 启动器与 Activity 标签、Capacitor 应用名称、浏览器文档标题、登录前产品标签、原生启动图标与 App Store Connect 记录都使用该身份。

Mobile Companion 仍是技术产品术语，DeepSeek Gestalt 仍是 Paired Desktop 与产品家族，`com.gestalt.mobile` 是 iOS bundle id 与 Android application id。Xcode `PRODUCT_NAME`、签名 archive 与安装包文件名、CI artifact 标识使用 `Gestalt`；它们是构建身份，不是展示文案。Platform Account、Personal Pairing、Relay、缓存、wire 与凭证标识不采用消费者品牌。

源图标是不透明的方形主图，不包含文字、水印、内置圆角遮罩或设定稿排版。iOS 消费 1024 像素主图，Android 消费每个仓内密度的经评审 legacy、round 与 adaptive launcher 派生图。Release build 在原生编译前执行聚焦品牌校验。

## Alternatives considered

**把 DeepSeek Gestalt 保留为已安装应用名。**不采用，因为已批准的产品方向为手机应用提供独立且可识别的消费者身份，同时在文档与架构中保留技术关系。

**复用千机-Gestalt 商店名、旧视觉身份或旧 application id。**不采用，因为已批准身份是 Gestalt namespace 下的獭子哥与其水獭。旧 id build 仍是预发布候选，不定义商店升级兼容性。

**把品牌本地化为不同应用名。**不采用，因为一个规范的专有名词可让已安装图标、商店列表、截图与支持引用在各语言中保持一致。

## Verification

Mobile 测试校验每个面向用户的名称所有者、独立的 Gestalt 构建身份、1024 像素且不透明的 iOS 图标、Android launcher 尺寸与 alpha 要求，并校验无效品牌输入会失败。iOS 与 Android release script 会在生成签名产物前运行该校验，然后检查原生安装包元数据中的请求版本与展示名称。Product-entry snapshot 与实际运行的原生验收校验可见标签与已安装 launcher 结果。

## Consequences

评审者与 release automation 必须一起更新每个已列出的名称所有者、原生 launcher 家族与原生 application identifier。携带其他名称、图标或 application identifier 的候选包即使仍有效的配对与 Relay 证据，也不能进入外部 Beta 分发。独立消费者品牌不会创建另一个 Mobile 状态模型、Platform 身份或 Desktop authority。application-id 变更会创建独立的原生 Installation identity，因此旧 id 预发布 build 的受保护配对状态不会迁移到 `com.gestalt.mobile`。
