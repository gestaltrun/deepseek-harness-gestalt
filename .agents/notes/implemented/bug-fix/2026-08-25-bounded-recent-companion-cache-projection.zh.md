# Agent Note：将 Companion Cache 限定为最近打开的 transcript

状态：已实现

[English](2026-08-25-bounded-recent-companion-cache-projection.md) | 中文

## 问题

Authenticated Mobile receiver 会保留一个 process lifetime 内打开过的所有 conversation，并把完整 aggregate 保存为一个 encrypted projection snapshot。真实 provider context 加上多个已打开 Session 会超过 61,440-byte Companion Cache ceiling。之后每个 live projection 都会重试并拒绝同一个 oversized save，使 Remote Offline 停留在更旧 snapshot。

## 决策

Receiver 会把每个更新后的 conversation 移到末尾，使 conversation map 顺序与最近 authenticated activity 相同。Cache persistence 会先保留完整 Desktop、Workspace 与 Session metadata，并且只保留最近的 conversation。如果结果仍超过 projection-snapshot ceiling，persistence 会移除最早 conversation node，直到确切 versioned JSON 可以装入，同时设置 `hasMore`。完整 metadata 本身超过 ceiling 时，persistence 会保留权威 Session list 的前缀，把各 Workspace 与 Session-keyed companion map 过滤到该前缀，并移除 transcript。只有 Desktop identity 加空 Session/Workspace state 仍无法装入的 projection 才会被拒绝。普通 cache byte ceiling 保持不变，仍由 `CompanionCache` 在 encryption 前执行。

## 考虑过的替代方案

**提高 projection-snapshot ceiling。** 拒绝，因为 cache retention 会随着 model context 与已打开 Session 增长，而现有 bound 会限制 storage、encryption work 与 startup parsing。

**继续保留 oversized predecessor 之前最后一次成功 snapshot。** 拒绝，因为之后每次 authenticated update 都会让 Remote Offline 静默展示 stale Session metadata。

**把每个 conversation 保存为独立无界 row。** 拒绝，因为 Mobile 只需要一个最近打开的 read-only transcript，而不是 Desktop Session storage 的 offline replica；每 Session 一 row 的 policy 还需要独立 eviction authority。

## 后果

真实 provider transcript 很长时，authenticated metadata 仍会持续推进。Remote Offline 会在可以装入时保留最新 active conversation tail，并在 synchronization 恢复后请求更旧 history。Oversized aggregate metadata 会推进为有界的 Session/Workspace 前缀，而不是保留 stale content。Cache encryption、Account 与 Personal Pairing isolation、excluded content kind 和 operation receipt 都不变。

## 测试

Cache runtime regression 会在现有 ceiling 下保存两个累计的 35,000-character conversation，恢复完整 metadata，并只保留最近 Session。Exact-limit、one-byte-over 与 multibyte metadata case 会验证完整 versioned UTF-8 bound，并验证 stale content 会被有效的 trimmed projection 替换。Receiver coverage 会在 recency reorder 后继续解析和发布 conversation snapshot 与 live update。
