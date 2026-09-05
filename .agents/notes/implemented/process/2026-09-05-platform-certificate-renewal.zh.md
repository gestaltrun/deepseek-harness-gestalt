# Agent Note: 通过生产 OIDC 续期 Platform 证书

Status: implemented

[English](2026-09-05-platform-certificate-renewal.md) | 中文

## Problem

实际运行的 ALB 证书通过本地 ACME home 与本地阿里云授权签发。这些状态无法支持无人值守续期：本地 OAuth 会过期，`/tmp` 不持久，而且工作站定时任务依赖某一台 Mac 持续在线。每次自动化运行都重新签发还会消耗证书颁发机构容量，并增加 DNS 与监听器变更风险。

## Decision

每日 GitHub Actions workflow 检查生产证书，并且仅在配置的续期窗口内续期。无特权 job 要求显式 enable 变量后，Environment `production` OIDC job 才能启动。有特权 job 承担既有阿里云部署角色，不使用阿里云 AccessKey 或工作站状态。

workflow 下载一个不可变的 acme.sh 源码归档，并在执行前校验其 SHA-256。ACME 账号与域名状态归档在既有私有部署 OSS bucket 的单个精确 key 下。bucket 使用 OSS 托管的 AES256 服务端加密，每次状态上传也会显式请求该加密。临时状态仅属主可访问，并在 job 退出时删除。

ACME DNS hook 通过 workflow 的 OIDC 凭据调用 AliDNS，而不是使用 acme.sh 的 AccessKey 集成，并且只接受两个确切的实际运行 challenge name。记录删除失败时会保留其 id 并使 job 失败。证书只有在私钥匹配、SAN 集合严格等于 apex 与 www、且剩余有效期满足配置下限后才能启用。listener 更新前，持久事务 metadata 会记录之前与候选 certificate id 及候选 fingerprint。两个域名在两个 ALB 地址上都必须提供该 fingerprint 才能 commit；TLS 或 metadata commit 失败会恢复之前的 binding，同时保留已续期 ACME state 供重试。workflow 绝不自动删除之前的证书。

手动执行默认只校验，不签发也不修改监听器。定时任务失败会作为 GitHub check 可见；续期窗口内的失败就是到期告警。

## Alternatives considered

**客户端 envelope encryption 或专用 KMS 密钥。** 拒绝，因为这会增加可复用解密 secret 或付费云服务。私有 OSS、AES256 服务端加密、精确 object OIDC authorization、HTTPS 与仅属主可访问的 runner 文件构成所选的低成本边界。

**阿里云 RAM 用户或 acme.sh AliDNS 插件。** 拒绝，因为两者都需要长期 AccessKey，而标准 AliDNS 插件还会把凭据持久化到 ACME 账号状态中。

**工作站 cron。** 拒绝，因为续期会依赖 Mac 在线与本地 OAuth 状态。

**每次定时执行都签发。** 拒绝，因为续期必须由活动证书有效期驱动，并保留证书颁发机构容量。

## Consequences

续期依赖 GitHub Actions 与 OSS control-plane confidentiality，而阿里云授权仍是短期联合身份。服务端加密保护存储介质与提供方备份，但拥有 object-read authority 的 OSS compromise 可以暴露 ACME 私有状态，因此精确 object IAM 是安全边界的一部分。之前的 CAS 证书继续保留用于显式回滚，生命周期清理属于另一项经审核的操作。

## Verification

可执行 shell 测试固定 OIDC 前 enable gate、无变更 validation、确切 DNS name 拒绝、OSS AES256 与仅属主可访问的状态，以及持久 commit 失败后的自动 prior-listener 恢复。静态 assertion 保留不可变 ACME 源码与凭据缺席检查。
