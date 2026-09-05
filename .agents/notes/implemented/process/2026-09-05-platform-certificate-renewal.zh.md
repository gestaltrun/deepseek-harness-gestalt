# Agent Note: 通过生产 OIDC 续期 Platform 证书

Status: implemented

[English](2026-09-05-platform-certificate-renewal.md) | 中文

## Problem

实际运行的 ALB 证书通过本地 ACME home 与本地阿里云授权签发。这些状态无法支持无人值守续期：本地 OAuth 会过期，`/tmp` 不持久，而且工作站定时任务依赖某一台 Mac 持续在线。每次自动化运行都重新签发还会消耗证书颁发机构容量，并增加 DNS 与监听器变更风险。

## Decision

每日 GitHub Actions workflow 检查生产证书，并且仅在配置的续期窗口内续期。它在 `production` Environment 中运行，通过 OIDC 承担既有阿里云部署角色，不使用阿里云 AccessKey 或工作站状态。

workflow 下载一个不可变的 acme.sh 源码归档，并在执行前校验其 SHA-256。ACME 账号与域名状态归档在既有私有部署 OSS bucket 的单个精确 key 下。bucket 使用 OSS 托管的 AES256 服务端加密，每次状态上传也会显式请求该加密。临时状态仅属主可访问，并在 job 退出时删除。

ACME DNS hook 通过 workflow 的 OIDC 凭据调用 AliDNS，而不是使用 acme.sh 的 AccessKey 集成。每个创建的挑战记录 id 都保存在私有临时文件中，并由保证执行的清理路径删除。证书只有在私钥匹配、SAN 集合严格等于 apex 与 www、且剩余有效期满足配置下限后才能启用。workflow 只更新实际运行的 ALB 监听器，通过正常 TLS 校验验证两个 ALB 地址，并且绝不自动删除之前的证书。

手动执行默认只校验，不签发也不修改监听器。定时任务失败会作为 GitHub check 可见；续期窗口内的失败就是到期告警。

## Alternatives considered

**客户端 envelope encryption 或专用 KMS 密钥。** 拒绝，因为这会增加可复用解密 secret 或付费云服务。私有 OSS、AES256 服务端加密、精确 object OIDC authorization、HTTPS 与仅属主可访问的 runner 文件构成所选的低成本边界。

**阿里云 RAM 用户或 acme.sh AliDNS 插件。** 拒绝，因为两者都需要长期 AccessKey，而标准 AliDNS 插件还会把凭据持久化到 ACME 账号状态中。

**工作站 cron。** 拒绝，因为续期会依赖 Mac 在线与本地 OAuth 状态。

**每次定时执行都签发。** 拒绝，因为续期必须由活动证书有效期驱动，并保留证书颁发机构容量。

## Consequences

续期依赖 GitHub Actions 与 OSS control-plane confidentiality，而阿里云授权仍是短期联合身份。服务端加密保护存储介质与提供方备份，但拥有 object-read authority 的 OSS compromise 可以暴露 ACME 私有状态，因此精确 object IAM 是安全边界的一部分。之前的 CAS 证书继续保留用于显式回滚，生命周期清理属于另一项经审核的操作。

## Verification

Platform workflow 测试固定 OIDC 权限、不可变 ACME 源码校验、到期与校验模式、OSS AES256 与仅属主可访问的状态、挑战清理、密钥／SAN／有效期校验顺序、仅监听器变更与旧证书保留。实际运行的 dry-run 在不签发证书的前提下校验当前 TLS 与云端读取路径。
