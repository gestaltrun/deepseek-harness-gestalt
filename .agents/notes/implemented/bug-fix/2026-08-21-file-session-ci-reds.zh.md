# Agent Note: Repair File/Session Reference CI reds

Status: implemented

[English](2026-08-21-file-session-ci-reds.md) | 中文

## Problem

File/Session Reference 同步到官方 Host `@path` / `file-reference-local` 与 `session-reference` 之后，Gestalt `#204` 上仍有四条合并阻塞红灯。Linux coverage 里 pwsh backend 把回显的 `PWSH_PROMPT_SETUP` 源码当成已安装的 `dsh> ` 提示符，于是 `tool-pwsh-persistent` 抽不到命令标记；同一用例里 relay 的 oversized 帧在 10 ms first-frame 期限下以 `1008` 而不是 `1009` 关闭。consumers 车道上 publint 拒绝 `remote-access-client` 的 hashed chunk，Web 设置金标仍列出已删除的工作区引用导航，Composer 图片标注 e2e 打开预览后没有 `Annotate image`。把 persistent-pwsh 快照刷成截断的 bootstrap，或把 hashed chunk 加进 `files` 白名单，都会把这些失败藏起来。

## Decision

**pwsh spawn 等到末行是默认 `PS …>` 提示符后，再在 Unix 上提交 LF、在 Windows 上提交 CR，并等待拆开的 `Write-Output` 完成标记，而不是重打的 `dsh> `。** 把官方 Host 的 `'dsh> '` 写回 `PWSH_PROMPT_SETUP` 后，Linux coverage 和 ACP `persistent-pwsh-tool-turn` 快照再次变红：PTY 在函数运行前就回显这段源码，spawn 返回，下一条写入叠上去。末行 / 连续 ready-probe / `-NoExit -Command` 也失败：Linux 常常不再打印末行 `dsh> `，出现在源码里的 probe 仍是假就绪，`-Command` 则把二进制倒进 PTY。空转到 `includes('dsh> ')` 会超时（`32456229621`），因为源码拆分后该文本不再重打。把一次空 follow-up 当成就绪（`32457685533`）会发布空 motd，loader 停在默认 `PS>`，第一条命令超时。只用 CR 提交去等 `__DSH_PWSH_SETUP_DONE__` 仍超时（`32459139618`）：Linux 上的 PSReadLine 把 CR 当成光标回行首，setup 行回显但不执行。提交 CRLF 仍超时（`32460394471`）：CR 仍会先回行，setup 行仍不执行。立即提交 LF 仍超时（`32462089006`）：scrollback 是 setup 源码加上第一道 `PS /tmp/…>`，写入落在横幅期间，从未执行。先 `initialize` 再写 setup 得到 `session_exit`（`32463876213`）：stdin-wait 可能在 150 ms 就 settle，此时提示符还没占住 TTY。只认末行 `PS …>` 时，scrollback 里已有提示符仍超时（`32465320155`）：Linux 上的 PSReadLine 会在路径两侧留下反色 CSI。去掉 SGR 后在第一次 stdin_wait 就写入，提示符后面打出乱码（`32466566587`）。要求 `inferred_idle` 则从未写入（`32467952709`）。提示符后再空等 `idleSilenceMs`，scrollback 仍只有 `PS /tmp/…>`（`32469299678`）。`-NoExit -File` 能打出标记，但后续发送为空或被 abort（`32470697182`）。spawn 返回时删掉隔离 HOME 也会丢掉后续发送（`32472737736`）。HOME 留到关闭后后续发送仍为空或被 abort（`32474124270`）。`PSConsoleHostReadLine`（`32479597008`）和空的 PSReadLine stub（`32480892916`）都会倒出 UTF-16 的 `Stop` / PerfTrack 并盖住标记。因此隔离 profile 跑 stdin `ReadLine` 循环，`exit` 之后由 `finally` 结束进程，该 HOME 保留到会话关闭，并等到标记加上 `dsh> `。之后提交仍在 Unix 上用 LF、在 Windows 上用 CR。setup 在运行时拼接提示符与 `__DSH_PWSH_SETUP_DONE__`，再 follow-up 直到 viewport 或 scrollback `includes` 拼好的标记。工具层同样等待 `__DSH_PWSH_TOOL_SETUP_DONE__`。`session_exit`、单次 send 的 `timeout` 与 spawn 墙 `timeoutMs` 仍拒绝。官方 inferred-idle 仍没有额外末行门槛。[persistent pwsh 笔记](../architecture/2026-08-11-pwsh-persistent-pty.zh.md) 仍拥有双层 prompt 安装。

**Relay 的载荷尺寸检查使用默认 first-frame 期限。** 空闲超时断言仍启动 10 ms 服务器。oversized 帧断言另启默认 1000 ms 的服务器，避免 attach-timeout 抢在 1009 关闭之前。

**`remote-access-client` 每个 entry 只发出一个文件。** 每个已发布文件各自一个 tsdown face，并设置 `outputOptions.codeSplitting: false`，与 compaction 和 JSON-RPC demo 一致。多 entry face 不能关闭 splitting。包的 `files` 白名单与 `packageFileExtras` 不变。

**设置金标去掉已删除的工作区引用行。** `ui-workspace-reference` 删除后导航不再有该项；期望树不再包含 `工作区引用`。

**Composer 预览恢复官方 pin overlay，InputBar 保留 Gestalt 注释计数。** `InputBar` 通过 `pinOverlayFor` 传入 `useComposerImagePinOverlay`。`ComposerAttachments` 自管 pin-mode，仅在用户对 `image/gif` 切换标注时设置 `annotation.gifRefuse`。打开预览本身不显示该警告。历史 pin 保持 `source: 'history'`；Composer pin 使用默认 `composer` source。两个 overlay hook 共用 `useImagePinOverlay`，避免 jscpd 把 Composer 恢复当成 history hook 的克隆。整份取官方 `InputBar` 丢掉了 Web e2e 依赖的 `{count} annotation` 摘要与丢弃控件；计数芯片、逐条编辑/删除，以及仅有注释时启用发送，仍留在 composer 卡片上。父会话离线的 continuable 子会话在独立 Stop 旁边保留禁用的 Send。空草稿插话对可见的 InputBar textarea 重试 Playwright 的 `fill` 加 `Enter`——残留的隐藏节点也带 `data-phase`——直到每一行都出现在队列里。

## Alternatives considered

**把 `dsh> ` 嵌进 `PWSH_PROMPT_SETUP`，并按官方 Host 那样用 `includes`。** 否决：Linux PTY 在函数运行前就回显这段源码，spawn 返回后下一条写入会叠上去。

**空转 follow-up 直到 viewport 或 scrollback `includes` 已安装提示符。** 否决：源码拆分后 Linux PTY 不再打印 `dsh> `，循环会撞上 `timeoutMs`（coverage run `32456229621`）。

**在已安装提示符缺失时，把一次空 follow-up 当成就绪。** 否决：spawn 发布了空 motd；loader 停在 `PS>`，第一条命令超时（coverage run `32457685533`）。

**仍用单独 CR 提交，只等待拆开的完成标记。** 否决：Linux 上的 PSReadLine 不执行 setup 行，标记不会出现（coverage run `32459139618`）。

**提交 pwsh 行时使用 CRLF。** 否决：coverage run `32460394471` 仍在 15 s 撞上 spawn 超时；CR 仍会先回行，setup 行仍不执行。

**spawn 后立即提交 LF。** 否决：coverage run `32462089006` 打出 setup 源码和第一道 `PS /tmp/…>`，没有标记；写入落在横幅期间，从未执行。

**先 `initialize` 再写 setup。** 否决：coverage run `32463876213` 在 setup 发送时 `session_exit`；stdin-wait 可能在 150 ms 就 settle，默认提示符还没占住 TTY。

**只认未去 SGR 的精确末行 `PS …>`。** 否决：coverage run `32465320155` 在 scrollback 已有 `PS /tmp/…>` 时仍超时；Linux 上的 PSReadLine 用反色 CSI 包住路径。

**第一次看见 `PS …>` 就写 setup。** 否决：coverage run `32466566587` 写在反色绘制期间；提示符后是乱码，标记没有出现。

**等到 `inferred_idle` 这个 waitReason 再写 setup。** 否决：coverage run `32467952709` 从未写入；开了 `acceptsStdinWait` 时，每次发送都在 `exactProbeAfterMs` 以 `stdin_wait` settle。

**默认提示符后空等 `idleSilenceMs`，再通过会话写 setup。** 否决：coverage run `32469299678` 超时，viewport 与 scrollback 只剩 `PS /tmp/…>`，标记没有出现。

**把 prompt 函数放进 argv 的 `-NoExit -Command`。** 否决：MOTD 变成 UTF-16/乱码，且没有 `keep=ok`。

**用 `-NoExit -File` 在 PSReadLine 启动前安装提示符。** 否决：coverage run `32470697182` 打出了标记，但后续发送为空（`keep=ok`）或 `PTY send aborted before write`。

**spawn 返回时删掉隔离 HOME。** 否决：coverage run `32472737736` 打出了标记，但后续发送为空（`keep=ok`），工具报 shell did not accept initialization。

**HOME 留到会话关闭，但仍走 PSReadLine。** 否决：coverage run `32474124270` 打出了标记，但后续发送为空（`keep=ok`）或 `PTY send aborted before write`，工具报 shell did not accept initialization。

**在隔离 profile 里 `Remove-Module PSReadLine`。** 否决：coverage run `32479597008` 打出 `dsh> ` 后是 UTF-16 的 `Stop:Powershell` / PerfTrack；spawn 等标记超时，后续命令回显进同一段乱码。

**定义 `PSConsoleHostReadLine`，或用空的 9.9.9 模块挡住 PSReadLine。** 否决：coverage run `32480892916` 在没有 `Remove-Module` 时仍是同一段 UTF-16 `Stop` / PerfTrack。

**要求末行 `dsh> `、`__DSH_PWSH_READY__` probe，或用 `pwsh -NoExit -Command` 预装提示符。** 否决：Linux 常常不再打印末行提示符，出现在源码里的 probe 仍是假就绪，`-Command` 则把二进制写入 PTY。

**把 `persistent-pwsh-tool-turn` 刷新成截断的 bootstrap 转录。** 否决：那是把假就绪失败记成成功。工具仍须在真正的第二次 prompt 安装之后抽出 `PWSH_OK`。

**把 hashed `lib/relay-*.js` 名字加进 `files`。** 否决：`check-workspace-constraints` 生成期望文件列表。拆出 chunk 是发出缺陷，不是打包例外。

**在三 entry 的 browser face 上设置 `codeSplitting: false`。** 否决：tsdown 在关闭 splitting 时拒绝多个 input。每个已发布文件各自一个 face。

**让 first-frame 与载荷尺寸共用一台 10 ms 服务器。** 否决：覆盖率分区负载下 attach 期限会先到，并以 1008 关闭。

**保留工作区引用金标行，只在用例之间关掉设置对话框。** 否决：产品导航已没有该行。共享 page 被 overlay 挡住是第一条金标过期的症状。

**一打开预览就显示 GIF 拒绝警告。** 否决：拒绝发生在切换标注时。PNG 预览不得带警告。

**给镜像的 pin hook 包 `jscpd:ignore`。** 否决：overlay 构造就是一个函数。忽略注释会把真克隆藏起来。

## Consequences

官方 File/Session Reference 仍是唯一的 `@` 文件源。persistent pwsh 等到末行是默认 `PS …>` 提示符后，再在 Unix 上提交 LF、在 Windows 上提交 CR，并等待拆开的 `Write-Output` 标记，因此 Linux coverage 和 ACP pwsh 快照在两个函数都跑完之后抽出 `PWSH_OK`，不再等待重打的 `dsh> `。Relay、publint、设置金标、Composer pin e2e 与注释计数芯片走修复后的路径。已删除的工作区引用 picker 金标保持删除。

## Testing

`packages/terminal/terminal-bash/tests/session.spec.ts` 钉住 pwsh 提交在 Unix 上写 LF、在 Windows 上写 CR，bash 提交仍写 CR。`packages/terminal/terminal-bash/tests/index.spec.ts` 钉住 pwsh spawn 去掉 `-NoProfile`、把 `HOME` 指到跑 stdin `ReadLine` 循环的隔离 profile，等到完成标记和 `dsh> `，且该 HOME 保留到会话关闭、`PWSH_PROMPT_SETUP` 既不含 `dsh> ` 也不含 `__DSH_PWSH_SETUP_DONE__`、仅有源码回显的首次 send 会继续等待，以及回显始终打不出该标记时 spawn 命中 `timeoutMs`。`local.spec.ts` 在 PATH 上有 `pwsh` 时要求 motd 含该标记，并且真实 spawn 之后出现 `keep=ok`。`packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` 会越过 setup 源码回显，等待 `__DSH_PWSH_TOOL_SETUP_DONE__`。`packages/client/ui-attachment/tests/message-image.client.spec.tsx` 覆盖历史 pin overlay、拒绝与落点。空草稿插话先入队第一行，再立刻在同一可见 InputBar 上发送第二行，让两行都在提问 composer 替换 textarea 之前挂上，然后用 Cmd+Enter 冲刷。steer-all 中段金标与同目录另一份 steering 中段金标一样保留 `Ask question waiting` 工具行。`packages/platform/remote-access-http/tests/relay.spec.ts` 仍在独立服务器上分别以 1008 关闭空闲、以 1009 关闭 oversized。`packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx` 与 `packages/client/ui-conversation/tests/composer-image-pins.client.spec.tsx` 覆盖标注、GIF 仅在切换时拒绝，以及 composer overlay 工厂。`pnpm run duplication` 拥有共享的 `useImagePinOverlay` 抽取。`packages/client/ui-conversation/tests/input-bar.client.spec.tsx` 覆盖注释计数芯片、丢弃、按 kind 删除与提交中锁定。Web 设置金标不再列出 `工作区引用`。`pnpm exec tsx scripts/gen-client-catalog.ts --check` 拥有 `ComposerAttachmentsOwnerProps.pinOverlayFor` 的目录正文。
