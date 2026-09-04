# 上游合并方案（DSH 0.1.2-rc.1 + Better Sidebar 0.18.0）

Date: 2026-09-03

本文档是双上游合并的裁决记录与执行计划，由仓库所有者逐项批准后固化。分析证据来自六份只读 subagent 报告（文件级交集、语义矛盾、sidebar 快照升级、Side Chat 深挖、session 事件机制深挖、裁决项深挖+合并力学实证）。

## 1. 事实基座

| 项 | 值 |
|---|---|
| fork 基线（ours） | `origin/master` = `501528e92a`（合并起点） |
| DSH 三方基准（base） | `47f943859bef60e4160492346772ded9b24f765a`（0.1.0-rc.5，fork 官方 upstream 基线；是 upstream/master 的祖先，与 fork 线零共同祖先） |
| DSH 上游目标（theirs） | `upstream/master` = `76fda72979`（0.1.2-rc.1；基线后 2688 commits，8327 文件变动） |
| Sidebar 快照基线 | `f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1`（omdsh-dev/DSH-better-sidebar，v0.16.1） |
| Sidebar 上游目标 | `f59ffd07417036baf3953310d42c7b40b280db78`（v0.18.0，177 commits，+9444/−2443） |
| 冲突实证 | `git merge-tree --write-tree --merge-base=47f94 origin/master upstream/master`：2579 路径 = 内容冲突 1943 + modify/delete 302 + delete/modify 248 + 边界 86；其中 ~609 个 `.i18n.yaml` 由翻译配对驱动吸收（需先 pnpm install） |

## 2. 已批准裁决

| # | 裁决项 | 决定 |
|---|---|---|
| D1 | subagent 子 LLM 路由治理（fork 放任路由 vs 上游用户授权白名单） | **融合白名单**：方案 A 为主——`selectForAgent`（tool-subagent/src/index.ts:620-640 区域）注入"部署预授权集"内存并集（+80~120 行）；不写用户设置文档；方案 B（Config `orchestrationRouting` 豁免，+50~80 行）仅在路由集不可枚举时叠加 |
| D2 | Side Chat 产品路线 | **坚持 fork 路线**（canonical conversation slot + mountSession + 首条消息建 Agent + 事务化归档关闭）；P5 刷新后重放 fork 替换：删上游 `sidechat-transcript.ts`/`markdown-labels.tsx`/`use-polling.ts` + 19 个渲染 locale key × 21 词典，12 个冲突文件换回 fork 版；上游 0.18.0 的冷恢复模型增强点（等价 fork `a29d38f01f`）注意保留 |
| D7 | session 事件跨构建分化 | **补 ignorable**：4 处 append 加第三参 `{ ignorable: true }`（member-question-sender/index.ts:648,718,729；browser-workspace/index.ts:530；apiproxy 移植后落点为 session-controller 内 admitAttachment 写点）。**独立地雷**：team/* 事件 fork v1 vs 上游 v2 同名不同版本，ignorable 不适用，合并取上游 v2 代码时保留 v1→v2 内存升级链（fold 多版本解码） |
| D8 | knip | **跟随上游删除**（907c6334c1）：删 knip.json、package.json:94,208、run-gates.ts:418,550,673,841、run-gates.spec.ts:154,239、rescope-vendor.ts 三块；接受 unused-export 静态信号消失 |
| — | 合并力学 | **嫁接基线**：`merge -s ours --allow-unrelated-histories 47f94`（记祖先不改树）→ `merge upstream/master`（真三方，base=47f94）。拒绝 rebase-port（fork 快照历史无可 replay delta；嫁接保留历史、未来同步收敛为增量 merge） |
| — | 阶段切分 | P0–P6 同一基线分支内分阶段完成，阶段以 commit/PR 分段 |
| — | 模型路由 | subagent 一律走 CLIProxyAPI provider：开发=grok-4.6；e2e/功能测试操作（含 Electron 启动类）=gemini-3.8-flash-high；深度分析/评审按需选 glm-5.3/gpt-5.6-sol/codex-auto-review |

## 3. 执行阶段

基线：worktree `.codex-worktrees/upstream-sync`，分支 `codex/feature-upstream-sync`。当前工作区（codex/desktop-boot-screen）不动。

- **P0 基线与嫁接**：worktree + 分支 + pnpm install（激活翻译配对合并驱动）→ 本规划文档 → `merge -s ours 47f94` → `merge upstream/master` → 冲突批量处置（见 §4）→ 合成 merge commit。
- **P1 结构移植**（merge commit 之上的修复 PR 序列）：
  - apiproxy 32 文件 + client/runtime 19 文件（merge 中暂保留 ours）在移植完成后删除；
  - F1 member-question：新建 `dsh-member-question-receiver/remote`（类比 dsh-goal/remote），事件走 `API_REMOTE_FORWARDED_EVENTS` 白名单，materializer/terminal 重试留 receiver Host 装配；
  - F2 goal fork seed → session-controller/commands.ts fork 路径；F3 无 shell Git → workspace-controller（复用上游 dsh-native-command runner）；F4 toolEligibility、F5 admitAttachment、F6 testWebSearch、F11 official 过滤、F12 maxImageDimension → 对应 controller 加方法级合入；F7/F9 收敛丢弃（上游已覆盖）；session-export 删 fork 副本（上游 session-log-export 唯一所有）；
  - client-runtime import 迁移：A 类 41 包 292 文件零手工（merge 取上游版已带新 import）；B 类 6 个 gestalt 独有包 36 文件手工（apps/mobile 14、ui-workbench 7、ui-member-questions 5、ui-better-sidebar 4、ui-browser 3、ui-desktop 3），PendingWait 系按 PendingSubmission+PendingInteractionPublisher 重写，SessionAdmissionAdapter/SessionModelRoute/MemberQuestionRecordView 为 fork 私有抽象须自留落点；
  - D5 mountSession 移植（400-650 行）：上游 `adapter.resolve(key)` 是对接点；bindings.tsx 加 ExplicitScopeProvider（+15）、scoped-slots.tsx+renderer.ts 加 renderSession（+35）、ui-renderer/index.ts 加回 mountSession（+20，签名逐字一致）、ui-conversation owner share 恢复 renderMode/openSession（+40-60）、provisional 语义补齐（0-60）、测试移植（250-400）；
  - D6 waterfall 融合（200-400 行）：`AskUserQuestionRequestEvent` 加可选 `memberRoute` 字段；BAD_INTENT 豁免平移；tool-ask-user 删本地/路由二分改统一 `ctx.userQuestions.ask`；sender 包内新增 host 侧未打 scope 标签的 waterfall answerer（~40 行，须先于 remote UI answerer 触达）；receiver/UI 链路零改动；
  - team/* v1→v2 fold 多版本解码。
- **P2 语义融合**：D1 方案 A 实施；packages/subagent 27 文件、interaction 12 文件、apps/web scaffold、fs、scripts 内容冲突逐个解（取上游+补 fork 增量）；24 个上游改名文件跟随。
- **P3 机械批**：生成物重跑（api-catalog/slot-catalog/docs catalog/module-graph）；pnpm-lock 重生；examples 快照随上游搬迁到顶层 `snapshots/` 重录；1905 个内嵌文件批量裁定（.agents/docs 取 fork 版为主，抽查）；`docs/` 18 个 apiproxy 术语文件整批改写为 controller/gateway。
- **P4 全量验证**：typecheck/build/test:coverage/test:snapshot/doc-sync/hygiene 全绿；desktop/mobile/platform 冒烟（Electron 功能测试用 gemini-3.8-flash-high 操作）。
- **P5 Sidebar 刷新**（DSH 合并落地后）：按 `packages/client/ui-better-sidebar/UPSTREAM.md` 程序 `git apply --3way`（f9153dfc..f59ffd07，限定 dsh.plugin.json/src/tsdown.config.ts）+ LOCAL-MODIFICATIONS 19 条重放 + 第 20 条 rc.1 适配；D2 裁决执行（Side Chat 重放替换）；人工裁决点 5 个：intercept（rc.1 后 `remote.session.openWorkspacePath` 可用，取上游新路径并保留 ui-deliverables 归还逻辑）、Side Chat 集群、tsdown `locale` chunk 合入 fork face 拆分、split-sidebar 新结构上重打 chromeOverlay/滚动条 gutter/fresh-session 起始页/overlay 不挂载、locales 描述性导出名移到 `chunks/locale.tsx`。
- **P6 收尾**：基线 merge-forward 当时 origin/master，基线→master 最终 PR（全部 closing keywords），票据关闭以 GitHub 合并状态为准。

## 4. Merge 冲突批量处置策略（P0 内）

| 冲突类 | 数量 | 策略 |
|---|---|---|
| modify/delete（fork 改、上游删，302） | 含 knip.json、apiproxy 32、client/runtime 19 | 默认 resolve=删除（跟随上游）；**例外：apiproxy + client/runtime 暂保留 ours**，P1 移植完成后删 |
| delete/modify（fork 删、上游改，248） | — | 逐个确认：上游新版是否仍应删除（已知 2 个重点：tool-fs/session-cwd.ts、apps/web produced-files.overlay.yml），其余默认维持 fork 删除 |
| 内容冲突（1943） | .agents/notes 516（驱动吸收大头）、packages/client 481、docs/subsystems 91、apps/web/cli 各 79、subagent 78 | 生成物/文档批量策略 + 语义区留 P2；`vendor/` 整目录取上游（fork 未动过） |
| add/add（86） | 真冲突仅 6 个（coverage-partitions 等） | 双侧相同 129 个零操作；fork 未碰 245 个取上游；ui-renderer 撞车包 21 文件逐文件三方 |
| fork 独有新文件（2621） | desktop/mobile/platform/browser/ui-* 等 | 静默保留，零冲突 |

## 5. 风险台账

1. P1 不绿则后续全停：apiproxy/client-runtime 移植卡在 desktop/sidebar/member-question 编译链上。merge commit 后中间态 typecheck 必红，P1 是止血阶段。
2. 上游无 CHANGELOG，alpha.1→rc.1 隐性 breaking 以 P4 全量验证兜底。
3. blob:none 部分克隆：合并需大量历史 blob，按需网络取回；大操作预留时间。
4. `-s ours` 嫁接是"祖先谎言"：在 merge commit message 与本节中显式记录，避免考古误读。
5. team/* v1 存量日志：合并后 Team 投影对旧日志报版本错，除非 v1→v2 升级链落地（P1 项）。
6. 发布/标签/GitHub Release 不在本计划授权范围，需逐项显式批准。

## 6. 分析证据索引

- 文件级交集：Tier-1 可信冲突 354；1905 内嵌核查；24 个上游改名跟随；6 个真 add/add。
- 语义矛盾：client 加载模型（rc.8 删 __DSH_MODULES__ → combo boot）、slot 契约（1b535f611c/d231c8777a）、apiproxy 删除（4f00a8b8 收尾 + 7 个前置迁移 commit）、vendor 4.0.2（6af96785b5）。
- Sidebar：0.18.0 硬墙 snapshotEvents/openWorkspacePath 在 DSH rc.1 合并后自然消失；__DSH_MODULES__ 回退删除对 fork 无害（fork 已有 ctx.modules）。
- Session 事件：上游 42dc2a46c2 收紧已被 2c6ff296af 回滚；ignorable 是官方保留的下游兼容通道（note 2026-08-30-retain-ignorable-external-session-events）。
