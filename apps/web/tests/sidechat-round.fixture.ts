import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

interface SideChatReplayConfig {
  file: string
  childFiles: string[]
}

interface SideChatReplayScriptExpectation {
  calls: { visibleAssistantText: string }[]
}

const snapshotDirectory = fileURLToPath(new URL('./snapshots/sidechat-round', import.meta.url))

/** Replay configuration used by the shipped Side Chat browser journey. */
export const sideChatRoundReplayConfig: SideChatReplayConfig = {
  file: fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url)),
  childFiles: [
    join(snapshotDirectory, 'restored-child.jsonl'),
    fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url)),
  ],
}

/** First and nested Side Chat response visible to the browser. */
export const SIDE_CHAT_RESPONSE = 'Event sourcing is a pattern where all changes to an application\'s state are stored as an immutable, append-only sequence of events, rather than persisting only the current state, enabling full auditability, temporal queries, and event-driven architectures.'

/** Restored Side Chat response visible to the browser. */
export const SIDE_CHAT_RESUME_RESPONSE = 'After restoration, event sourcing still represents application state as an immutable sequence of recorded changes.'

/** Replay calls the Side Chat journey must consume in first-call bind order. */
export const sideChatRoundReplayExpectation: readonly SideChatReplayScriptExpectation[] = [
  { calls: [{ visibleAssistantText: SIDE_CHAT_RESPONSE }] },
  { calls: [{ visibleAssistantText: SIDE_CHAT_RESPONSE }, { visibleAssistantText: SIDE_CHAT_RESUME_RESPONSE }] },
  { calls: [{ visibleAssistantText: SIDE_CHAT_RESPONSE }] },
]
