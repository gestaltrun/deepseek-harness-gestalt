# Agent Note: 通过生产 OIDC 续期 Platform 证书

Status: implemented

[English](2026-09-05-platform-certificate-renewal.md) | 中文

## Problem

实际运行的 ALB 证书通过本地 ACME home 与本地阿里云授权签发。这些状态无法支持无人值守续期：本地 OAuth 会过期，`/tmp` 不持久，而且工作站定时任务依赖某一台 Mac 持续在线。每次自动化运行都重新签发还会消耗证书颁发机构容量，并增加 DNS 与监听器变更风险。

## Decision

每日 GitHub Actions workflow 检查生产证书，并且仅在配置的续期窗口内续期。无特权 job 要求显式 enable 变量，且 workflow commit 已包含在 `master` 中，Environment `production` OIDC job 才能启动。有特权 job 承担既有阿里云部署角色，不使用阿里云 AccessKey 或工作站状态。

workflow 下载一个不可变的 acme.sh 源码归档，并在执行前校验其 SHA-256。ACME 账号与域名状态归档在既有私有部署 OSS bucket 的单个精确 key 下。bucket 使用 OSS 托管的 AES256 服务端加密，每次状态上传也会显式请求该加密。临时状态仅属主可访问，并在 job 退出时删除。

ACME DNS hook 通过 workflow 的 OIDC 凭据调用 AliDNS，而不是使用 acme.sh 的 AccessKey 集成，只接受两个确切的实际运行 challenge name，并在每次新增后立即把 record id 持久化到事务对象。续期运行会在到期检查前重试任何事务 phase 中记录的所有遗留 challenge id，并且绝不删除不属于自己的记录，因此 runner 在新增与持久化之间被杀死最多遗留一条 challenge 记录，该记录在运维移除前保持无害；记录删除失败会保留其 id 并使 job 失败。当 OSS 无法保存该清理证据时，剩余 id 会保留在仅属主可访问的本地证据文件中，workflow 会把它上传为运行 artifact；由于仓库读者可以访问 artifact，证据只包含这些 id、其数量与哈希以及失败上传的退出状态，失败输出会指明该文件而不是声称已具备远端持久证据。固定版本的阿里云 CLI 通过精确大小写的 `-FILE` 文件读取 flag 接收证书与私钥——这是其 3.4.11 RPC parser 唯一会展开为文件内容的形式——因此私钥材料不会出现在命令行或日志中。证书只有在私钥匹配、SAN 集合严格等于 apex 与 www、且剩余有效期满足配置下限后才能启用。listener 更新前，持久事务 metadata 会记录之前与候选 certificate id 及候选 fingerprint；事务对象从不删除，由终态 committed phase 关闭。两个域名在两个 ALB 地址上都必须提供该 fingerprint 才能 commit；TLS 或 metadata commit 失败会恢复已记录的之前 binding——即使 listener 已经提供候选证书也已取得回滚所有权——同时保留已续期 ACME state 供重试。workflow 绝不自动删除之前的证书。

手动执行默认只校验，不签发也不修改监听器。定时任务失败会作为 GitHub check 可见；续期窗口内的失败就是到期告警。

## Alternatives considered

**客户端 envelope encryption 或专用 KMS 密钥。** 拒绝，因为这会增加可复用解密 secret 或付费云服务。私有 OSS、AES256 服务端加密、精确 object OIDC authorization、HTTPS 与仅属主可访问的 runner 文件构成所选的低成本边界。

**阿里云 RAM 用户或 acme.sh AliDNS 插件。** 拒绝，因为两者都需要长期 AccessKey，而标准 AliDNS 插件还会把凭据持久化到 ACME 账号状态中。

**工作站 cron。** 拒绝，因为续期会依赖 Mac 在线与本地 OAuth 状态。

**每次定时执行都签发。** 拒绝，因为续期必须由活动证书有效期驱动，并保留证书颁发机构容量。

**扫描两个精确 challenge name 以清理遗留记录。** 拒绝，因为这会删除不属于本续期的 TXT 记录——同名下并发或手工 ACME 流程会失去其 challenge。所有权只来自持久化的 record id 账本；新增中途被杀死导致的单条记录孤儿窗口改为明确文档化，而不是虚假地保证清理干净。

## Consequences

续期依赖 GitHub Actions 与 OSS control-plane confidentiality，而阿里云授权仍是短期联合身份。服务端加密保护存储介质与提供方备份，但拥有 object-read authority 的 OSS compromise 可以暴露 ACME 私有状态，因此续期策略仅限于对恰好两个 OSS key——状态归档及其相邻事务记录——的 Get 与 Put，不授予 prefix 级访问或对象删除权限，该精确 key IAM 是安全边界的一部分。清理失败证据可以回退到仅属主可访问的 runner 文件并上传为运行 artifact；artifact 没有私有开关且仓库读者可以访问，因此证据仅限于操作性的 record id、其数量与哈希以及失败上传的退出状态——不包含原始命令输出，也不包含任何 secret。workflow 的 master ancestry 检查防止意外分支启用，但不能防御不受限制的 production Environment 所准入的恶意 workflow。启用时会另行验证 Environment branch restriction 与 OIDC trust。之前的 CAS 证书继续保留用于显式回滚，生命周期清理属于另一项经审核的操作。

## Verification

可执行 shell 测试固定 OIDC 前 enable gate、无变更 validation、只报告不变更的待处理签发与清理事务、确切 DNS name 拒绝、OSS AES256 与仅属主可访问的状态，以及持久 commit 失败或对账失败后的自动 prior-listener 恢复——包括 listener 已经提供已记录候选证书的情形。有状态的 mock cloud 驱动待处理清理事务的两运行恢复（删除重试与终态关闭）、签发事务上记录的 challenge id 重试、启用前的逐条新增持久化、保留所有权的清理（已记录 id 被删除而同一 challenge name 下的未知记录保留），以及 OSS 不可用时的受保护本地证据（仅含脱敏的状态、数量与哈希）。证书上传路径针对真实 aliyun-cli 3.4.11 parser 固定：其源码（openapi/rpc.go）只展开精确大小写的 `-FILE` 后缀，经由固定版本二进制的拦截请求确认 `--Cert-FILE`/`--Key-FILE` 会把文件内容放入签名请求，而小写写法则被拒绝、`file://` 值会被原样发送；mock endpoint 复现该 parser，因此任一类回归都会让测试失败。静态 assertion 保留不可变 ACME 源码、凭据缺席与失败 artifact workflow 检查。
