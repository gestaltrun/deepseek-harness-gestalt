# Agent Note: Keyless Project Members assembled acceptance

Status: implemented

[English](2026-09-04-project-members-assembled-acceptance.md) | 中文

## Problem

规格 #338 与工单 #345 要求一次功能级组装走查，覆盖真实组件：两个账号、三个安装、真实 listener，以及从绑定、邀请、在线状态、带分块参考材料的路由提问、首个 claim 回答、到期、撤回、取代到离线不排队的全部用户可见转换。包测试与内存发送器桩无法证明 Account、Project Membership HTTP、T4 codec、发送器、Host 接收器与 Desktop 安装对这些转换达成一致，也无法证明 Platform 保留状态不含业务明文。

## Decision

#345 的组装证据是一个本地可运行、无 SHA-256 握手的 AES-256-GCM 开发 broker，加上真实的 Account 与 Project Membership TCP 组合。`apps/desktop/tests/member-question-e2e/assembled-project-members.spec.ts` 启动一个本地 Platform、两个账号（`ada`、`grace`）和三个 Installation endpoint。它走查创建、按登录名邀请、不完整 accept-with-link 仍保持 pending、完整 accept-with-link、由实时心跳产生的花名册 Online、最后窗口 `/v1/projects/presence/close` 的 Offline、一次携带 background 以及 markdown/html/任意分块字节的路由提问、receiver 所有的 Files-sidebar 缓存路径（`.dsh/member-questions/<questionId>/`）且没有本地 composer 卡片、B1/B2 并发首个 claim 结算（含 answered-elsewhere 元数据）、到期、发起方撤回、同路线取代，以及无排队投递的 `MEMBER_OFFLINE`。关闭断言在轮询真实 HTTP 花名册时只续约期望保持 Online 的 Installation lease，绝不续约刚关闭的 Installation。注入时钟的 registry 测试证明 close 在时钟不推进时删除目标，TCP HTTP consumer 测试证明该路由调用这一行为；组装走查覆盖多 Installation 花名册组合，不依赖小于 TTL 的时序窗口。单独的 125 毫秒等待仍验证自然 TTL 到期。时钟与密钥是唯一注入的非确定性。broker 审计与 Platform membership 文档只含密文与权限行。

可见 Desktop 覆盖是 `pnpm run test:e2e-project-members-electron`。它重建当前源码，对着同一本地 Platform 启动三个隔离 Electron 进程，并在 Linux 上要求可见 `DISPLAY`。`--dsh-e2e-profile` 只被显式的未打包 `DSH_DESKTOP_E2E=1` 运行接受。生产密封仍受常设独立加密评审约束。

发送器通过 `deriveMemberQuestionDocumentTransferId` 将对齐的文档字节编码为 Companion `document-chunk` 帧。接收器的 `MemberQuestionDocumentAssembler` 在 Host ingest 把接收端所有的缓存文件写入 `.dsh/member-questions/<questionId>/` 之前重组这些帧。`apps/desktop/tests/member-question-e2e/document-chunk-reassembly.snapshot.ts` 把该编码/线路/重组转录记录到 `snapshots/document-chunk-reassembly.expected.json`。`apps/desktop/tests/member-question-e2e/assembled-project-members.snapshot.ts` 把组装走查记录为 JSONL，对照 `snapshots/assembled-project-members.expected.jsonl`。

## Alternatives considered

**把 `examples/project-members` 快照当作足够证据。** 否决：该组合只播种内存花名册和内存发送器，从不执行 Account session、Project Membership HTTP、presence 心跳或加密多安装投递。

**等待运营 GitHub OAuth 与已评审的生产加密。** 那仍是生产激活路径，但不能作为仓库的无密钥回归。本地 Platform 与密文 broker 是替代证据，并非产品密码学已经发货。

**只通过 Electron 驱动组装走查。** 否决：WDIO 通道需要显示器、重建后的 Desktop 和三个进程。进程内组装规格仍是始终可运行的 macOS/Linux 无密钥门禁；Electron 是可见的三安装叠加层。

**把传输文档正文存进接收器 ledger。** 否决：T9 已把这些字节写到接收端所有的 Workspace 缓存，且 ledger 已排除参考材料正文。

## Consequences

#345 可以在没有开发 Platform 部署的情况下，依靠无密钥组装与源码 Electron 证据关闭。运营 GitHub 账号、独立加密评审以及 baseline 到 master 的 PR 仍是分开的证据。密文 broker 与 `--dsh-e2e-profile` 不进入打包路径。

## Testing

- `pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/member-question-e2e/document-chunk-reassembly.snapshot.ts apps/desktop/tests/member-question-e2e/assembled-project-members.snapshot.ts`
- `pnpm exec vitest run apps/desktop/tests/member-question-e2e/assembled-project-members.spec.ts apps/desktop/tests/member-question-e2e/keyless-transport.spec.ts apps/desktop/tests/e2e-profile.spec.ts`
- `pnpm exec vitest run packages/interaction/member-question-sender/tests/document-transfer.spec.ts packages/interaction/member-question-receiver/tests/document-transfer.spec.ts packages/platform/remote-protocol/tests/companion-document-transfer.spec.ts`
- 在有可见显示器的主机上运行 `pnpm run test:e2e-project-members-electron`

## Related

- 工单 #345（父规格 #338）
- [项目成员权威](../feature/2026-08-27-project-membership-core.zh.md)
- [成员提问发送器](../feature/2026-08-28-member-question-sender.zh.md)
- [Host 所有的接收器 ledger](../architecture/2026-08-31-host-owned-member-question-receiver-ledger.zh.md)
