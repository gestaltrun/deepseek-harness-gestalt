/** Keyless development composition for exercising the bundled Mobile product entry. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  type SessionId,
  type ToolResultNode,
  type WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MobileCompanionPresentation } from './companion-history.ts'
import {
  adaptMobileCompanionProjection,
  type MobileCompanionProjectionDto,
} from './companion-projection.ts'

type MobileConversationProjectionDto = MobileCompanionProjectionDto['conversations'][number]

const SESSION_ID = 'mobile-keyless-presentation' as SessionId
const APPROVAL_SESSION_ID = 'mobile-keyless-approval' as SessionId
const QUESTION_SESSION_ID = 'mobile-keyless-question' as SessionId
const WORKSPACE_ID = 'mobile-keyless-workspace' as WorkspaceId
const IMAGE = {
  attachmentId: 'mobile-keyless-image' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/gif',
  bytes: 35,
  width: 1,
  height: 1,
  name: 'shared-image.gif',
} satisfies ImageAttachmentRef

function tool(
  seq: number,
  callId: string,
  call: NonNullable<ToolResultNode['call']>,
  resultView: ToolResultNode['resultView'],
  content: ToolResultNode['content'] = [],
): MobileConversationProjectionDto['nodes'][number] {
  return {
    kind: 'tool-result',
    seq,
    time: seq * 1_000,
    callId,
    call,
    callTime: seq * 1_000 - 500,
    content,
    isError: false,
    callView: null,
    resultView,
    subCalls: [],
  } as unknown as MobileConversationProjectionDto['nodes'][number]
}

const conversation: MobileConversationProjectionDto = {
  sessionId: SESSION_ID,
  nodes: [
    {
      kind: 'user', seq: 1, time: 1_000, source: null,
      content: [{ type: 'text', text: `Shared narrow conversation ${'overflow-'.repeat(24)}` }],
    },
    {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
      blocks: [
        { kind: 'text', text: '**Shared Markdown**\n\n```ts\nconst mobile = "desktop-web"\n```' },
        { kind: 'image', attachment: IMAGE },
      ],
    },
    tool(
      3,
      'mobile-edit',
      { name: 'edit', argsRaw: '{"file_path":"src/shared-presentation.ts"}' },
      { card: 'diff', diffs: [{ path: 'src/shared-presentation.ts', oldText: 'const shared = false', newText: 'const shared = true' }] },
    ),
    tool(
      4,
      'mobile-bash',
      { name: 'bash', argsRaw: '{"command":"pnpm test","description":"Run focused tests"}' },
      { card: 'terminal', output: '84 tests passed\n', exitCode: 0 },
    ),
    tool(
      5,
      'mobile-unknown',
      { name: 'future_tool', argsRaw: '{"query":"unknown fallback"}' },
      null,
      [{ type: 'text', text: '{"answer":42}' }],
    ),
    { kind: 'turn-error', seq: 6, time: 6_000, turn: 1, step: 1, message: 'Host rejected request', code: 'HOST_400' },
  ],
  turnTimings: [],
  turnEnds: [],
  partial: null,
  runningCalls: [],
  pending: [],
  queue: [],
  running: false,
  subagent: null,
  composerPhase: 'active',
  removed: false,
  openState: 'open',
  openError: null,
  hasMore: false,
  loadingOlder: false,
  promptError: null,
  blank: false,
  lastAgentError: null,
}

function interactionConversation(
  sessionId: SessionId,
  pending: MobileConversationProjectionDto['pending'],
): MobileConversationProjectionDto {
  return {
    ...conversation,
    sessionId,
    nodes: [],
    pending,
  }
}

const projection: MobileCompanionProjectionDto = {
  type: 'desktop-resync',
  version: 1,
  authenticated: true,
  desktopName: 'Keyless projection example',
  sessions: {
    ids: [SESSION_ID, APPROVAL_SESSION_ID, QUESTION_SESSION_ID],
    byId: {
      [SESSION_ID]: {
        id: SESSION_ID, title: 'Shared Web presentation', displayTitle: 'Shared Web presentation',
        cwd: '/workspace/deepseek-harness', running: false, blank: false, updatedAt: 3_000,
      },
      [APPROVAL_SESSION_ID]: {
        id: APPROVAL_SESSION_ID, title: 'Shared Approval', displayTitle: 'Shared Approval',
        cwd: '/workspace/deepseek-harness', running: true, pendingInteraction: 'approval',
        blank: false, updatedAt: 2_000,
      },
      [QUESTION_SESSION_ID]: {
        id: QUESTION_SESSION_ID, title: 'Shared Ask User', displayTitle: 'Shared Ask User',
        cwd: '/workspace/deepseek-harness', running: true, pendingInteraction: 'question',
        blank: false, updatedAt: 1_000,
      },
    },
    current: null,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: null,
  },
  workspaces: [{
    workspaceId: WORKSPACE_ID,
    path: '/workspace/deepseek-harness',
    title: 'DSH',
    sessionIds: [SESSION_ID, APPROVAL_SESSION_ID, QUESTION_SESSION_ID],
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  }],
  conversations: [
    conversation,
    interactionConversation(APPROVAL_SESSION_ID, [{
      kind: 'approval', interactionId: 'mobile-keyless-approval-rpc', sessionId: APPROVAL_SESSION_ID,
      payload: {
        approvalId: 'mobile-keyless-approval-id' as never,
        toolName: 'write',
        reason: 'Allow shared presentation evidence',
      },
    }]),
    interactionConversation(QUESTION_SESSION_ID, [{
      kind: 'question', interactionId: 'mobile-keyless-question-rpc', sessionId: QUESTION_SESSION_ID,
      payload: {
        questions: [{
          id: 'mobile-keyless-question-id',
          header: 'Bundled entry evidence',
          question: 'Which shared presentation is mounted?',
          options: [{ label: 'Desktop Web components (Recommended)' }, { label: 'A duplicate Mobile renderer' }],
        }],
      },
    }]),
  ],
}

/**
 * Create a keyless authoritative-projection example through the production composition interface.
 * @returns development-only Mobile Companion presentation with local interaction evidence callbacks.
 */
export function developmentCompanionPresentation(): MobileCompanionPresentation {
  const adapted = adaptMobileCompanionProjection(projection, () => Promise.resolve({ accepted: true }))
  return {
    ...adapted,
    connection: 'offline',
    canMutate: true,
    search: { query: '', status: 'idle', items: [], hasMore: false },
    attachment: { status: 'idle' },
    onSubmit: (sessionId, text) => {
      if (sessionId !== SESSION_ID || text.trim() === '') {
        return Promise.reject(new Error('development prompt is outside the input evidence Session'))
      }
      return Promise.resolve()
    },
    loadImage: (sessionId, attachment) => {
      if (sessionId !== SESSION_ID || attachment.attachmentId !== IMAGE.attachmentId) {
        return Promise.reject(new Error('development Mobile image is outside the selected Session'))
      }
      return Promise.resolve('data:image/gif;base64,R0lGODlhAQABAAAAACw=')
    },
  }
}
