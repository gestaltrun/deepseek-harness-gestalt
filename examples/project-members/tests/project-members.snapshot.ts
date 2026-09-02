import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  normalizeSessionLog,
  scrubRequestHeaders,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

interface JsonObject {
  [key: string]: unknown
}

const binScript = fileURLToPath(new URL('../start.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const streamExpected = fileURLToPath(new URL('./snapshots/stream-json.expected.jsonl', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

/** The roster the in-memory membership provider seeds, as the model receives it. */
const ROSTER_TEXT = JSON.stringify([
  { accountId: 'acc-demo-owner', displayName: 'Demo Owner', role: 'owner', tags: ['founding'], presence: 'online' },
  { accountId: 'acc-demo-dev', displayName: 'grace', role: 'member', tags: ['review'], presence: 'offline' },
])
const MEMBER_ANSWER_TEXT = '{"answers":[{"id":"rollout","selected":["approve"]}]}'
const FINAL_TEXT = `PROJECT_MEMBERS_ROSTER ${ROSTER_TEXT} PROJECT_MEMBER_ANSWER ${MEMBER_ANSWER_TEXT}`

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

/**
 * Scrub the streamed transcript: each streamed event is normalized as its own
 * record so the shared normalizers zero its time, and the reassembled records
 * are scrubbed once more so the run's session ids, generated cwd, and
 * request-header bulk become stable tokens — the expected output carries no
 * absolute path and replays on macOS/Linux.
 */
function normalizeStream(rawStdout: string, cwd: string): string {
  const records = parseJsonl(rawStdout)
  if (records.length === 0) throw new Error('project-members snapshot emitted no stream records')
  if (records.at(-1)?.type !== 'result') throw new Error('project-members snapshot did not end with a result record')
  const context: NormalizeContext = {
    sessionIds: [...new Set(records.flatMap(record => typeof record.sessionId === 'string' ? [record.sessionId] : []))],
    cwd,
  }
  const scrub = (lines: readonly unknown[]): string => scrubRequestHeaders(normalizeSessionLog(
    `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
    context,
  )).replaceAll(/mq[a-f0-9]{32}/g, '{{questionId}}')
  const values = parseJsonl(scrub(records.map(record => record.type === 'session_event' ? record.event : record)))
  if (values.length !== records.length) throw new Error('project-members transcript normalization changed the record count')
  const reassembled = records.map((record, index) =>
    record.type === 'session_event' ? { ...record, event: values[index] } : values[index],
  )
  return parseJsonl(scrub(reassembled)).map(record => JSON.stringify(record)).join('\n') + '\n'
}

/** The text blocks of one assistant message. */
function assistantText(event: JsonObject | undefined): string {
  const message = (event?.data as JsonObject | undefined)?.message as JsonObject | undefined
  return (Array.isArray(message?.content) ? message.content as JsonObject[] : [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('project_members keyless assembled transcript', () => {
  it('boots the composition and reads the roster through the real agent loop', async () => {
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'project-members keyless transcript snapshot',
      tempDirPrefix: 'project-members-keyless-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath],
      tsconfigPath,
      prepare: (cwd) => { runCwd = cwd },
    })

    expect(result.stderr).toBe('')
    const records = parseJsonl(result.stdout)
    const events = records
      .filter(record => record.type === 'session_event')
      .map(record => record.event as JsonObject)
    const calls = events
      .filter(event => event.type === 'tool/call')
      .map(event => (event.data as JsonObject).name)
    expect(calls).toEqual(['project_members', 'ask_user_question'])
    const resultEvents = events.filter(event => event.type === 'tool/result')
    const message = (resultEvents[0]?.data as JsonObject | undefined)?.message as JsonObject | undefined
    const text = (Array.isArray(message?.content) ? message.content as JsonObject[] : [])
      .flatMap(block => Array.isArray(block.content) ? block.content as JsonObject[] : [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text).toBe(ROSTER_TEXT)
    const memberMessage = (resultEvents[1]?.data as JsonObject | undefined)?.message as JsonObject | undefined
    const memberText = (Array.isArray(memberMessage?.content) ? memberMessage.content as JsonObject[] : [])
      .flatMap(block => Array.isArray(block.content) ? block.content as JsonObject[] : [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(memberText).toBe(MEMBER_ANSWER_TEXT)
    const askCall = events.find(event => event.type === 'tool/call'
      && (event.data as JsonObject).name === 'ask_user_question')
    const askArguments = JSON.parse(String((askCall?.data as JsonObject | undefined)?.arguments ?? '{}')) as JsonObject
    expect(askArguments.to_project_member).toBe('grace')
    expect(events.filter(event => event.type === 'member-question/asked')).toHaveLength(1)
    expect(events.filter(event => event.type === 'member-question/outcome')).toHaveLength(1)
    expect(assistantText(events.filter(event => event.type === 'assistant/message').at(-1)))
      .toBe(FINAL_TEXT)
    expect((records.at(-1) as JsonObject).output).toBe(FINAL_TEXT)

    const normalized = normalizeStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    expect(normalized).toBe(await readFile(streamExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
