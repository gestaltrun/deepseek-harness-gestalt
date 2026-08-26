import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  parseRelayCredential,
  parseRelayRouteId,
} from '@deepseek-ai/dsh-remote-protocol'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { CompanionForegroundRuntime } from '../../src/companion-lifecycle.ts'
import { fixedMobilePresentationClock } from '../../src/mobile-clock.ts'
import { mountMobileEntry } from '../../src/mobile-entry.tsx'
import type { MobilePairingActions, MobilePairingSnapshot } from '../../src/personal-pairing-model.ts'
import type {
  MobileCompanionConnectionChannel,
  ValidatedDesktopSurfaceResync,
} from '../../src/companion-surface.ts'

type EvidenceMode = 'approval' | 'question' | 'composer' | 'live'

declare global {
  interface Window {
    __DSH_MOBILE_PRODUCT_EVIDENCE__: {
      show(mode: EvidenceMode): void
      showPairing(status: 'paired' | 'rejected'): void
    }
  }
}

const SESSION_ID = 'shared-session' as SessionId
const BACKGROUND_SESSION_ID = 'background-session' as SessionId
const LONG_TEXT = Array.from({ length: 80 }, (_, index) => `long-line-${String(index)}`).join('\n')

/** Built-entry fixture launch; selected only by the snapshot Vite resolver. */
export function launchMobileProduct(_start: () => Promise<void>): Promise<void> {
  const root = document.getElementById('root')
  if (root === null) throw new Error('mobile product fixture: missing #root')
  const runtime = new CompanionForegroundRuntime()
  runtime.configure({
    routeId: parseRelayRouteId('route-product-entry'),
    endpoint: 'mobile',
    credential: parseRelayCredential('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'),
    revision: 1,
  })
  runtime.markConnectionOpen()
  const pairing = pairingEvidence()
  const mounted = mountMobileEntry(root, {
    installation: signedInInstallation(),
    pairing: pairing.actions,
    companion: runtime,
    clock: fixedMobilePresentationClock(10_000),
  })
  const receiver = mounted.companionSurface.bindAuthenticatedConnection(connectionChannel())
  if (receiver === undefined) throw new Error('mobile product fixture: missing authenticated receiver')
  const show = (mode: EvidenceMode): void => {
    receiver.acceptValidatedDesktopResync(projection(mode))
  }
  window.__DSH_MOBILE_PRODUCT_EVIDENCE__ = {
    show,
    showPairing: (status) => { pairing.show(status) },
  }
  show('approval')
  return Promise.resolve()
}

function pairingEvidence(): {
  actions: MobilePairingActions
  show(status: 'paired' | 'rejected'): void
} {
  const selected = parsePersonalPairingId('pairing-product-entry')
  const paired: MobilePairingSnapshot = {
    status: 'paired' as const,
    desktops: [
      { pairingId: selected, desktopName: 'Authenticated Shared Desktop' },
      { pairingId: parsePersonalPairingId('pairing-secondary'), desktopName: 'Secondary Desktop' },
    ],
    selectedPairingId: selected,
  }
  let snapshot: MobilePairingSnapshot = paired
  const listeners = new Set<() => void>()
  const actions: MobilePairingActions = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    completeLink: () => {},
    scanQr: () => {},
    retryPairing: () => {},
    selectDesktop: () => {},
    activate: async () => {},
    deactivate: async () => {},
    unpair: async () => {},
  }
  return {
    actions,
    show: (status) => {
      snapshot = status === 'paired'
        ? paired
        : { status: 'rejected', error: 'Desktop rejected Personal Pairing.' }
      for (const listener of listeners) listener()
    },
  }
}

function signedInInstallation(): PlatformAccountInstallation {
  const snapshot = {
    status: 'signed-in' as const,
    privacyAccepted: true,
    account: {
      id: 'account-product-entry' as never,
      githubId: 583_231,
      githubLogin: 'shared-product',
      avatarUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2232%22 fill=%22%231c1d21%22/%3E%3Ctext x=%2232%22 y=%2241%22 text-anchor=%22middle%22 font-size=%2228%22 fill=%22white%22%3ES%3C/text%3E%3C/svg%3E',
    },
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    load: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  } as unknown as PlatformAccountInstallation
}

function connectionChannel(): MobileCompanionConnectionChannel {
  const tracked = () => ({ operationId: crypto.randomUUID() as never, completion: Promise.resolve() })
  return {
    mutations: {
      refreshSurface: tracked,
      create: tracked,
      submit: tracked,
      cancel: tracked,
      attach: tracked,
      search: tracked,
      observeSession: tracked,
      loadOlder: tracked,
      settle: async () => ({ accepted: true }),
    },
    content: {
      loadImage: async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    },
  }
}

function projection(mode: EvidenceMode): ValidatedDesktopSurfaceResync {
  const live = mode === 'live'
  return {
    type: 'desktop-resync',
    version: 1,
    authenticated: true,
    desktopName: 'Authenticated Shared Desktop',
    sessions: {
      ids: live ? [SESSION_ID, BACKGROUND_SESSION_ID] : [SESSION_ID],
      byId: {
        [SESSION_ID]: {
          id: SESSION_ID,
          title: 'Shared Session',
          displayTitle: 'Shared Session',
          cwd: '/work',
          running: mode === 'approval',
          blank: false,
          updatedAt: 1,
        },
        ...(live ? {
          [BACKGROUND_SESSION_ID]: {
            id: BACKGROUND_SESSION_ID,
            title: 'Background Session Updated Live',
            displayTitle: 'Background Session Updated Live',
            cwd: '/work',
            running: false,
            blank: false,
            updatedAt: 2,
          },
        } : {}),
      },
      current: null,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: null,
    },
    workspaces: [{
      workspaceId: 'workspace-shared',
      path: '/work',
      title: 'Shared Workspace',
      sessionIds: live ? [SESSION_ID, BACKGROUND_SESSION_ID] : [SESSION_ID],
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    }],
    conversations: [conversation(mode)],
  }
}

function conversation(mode: EvidenceMode): ValidatedDesktopSurfaceResync['conversations'][number] {
  return {
    sessionId: SESSION_ID,
    nodes: [
      {
        kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: '**Shared Markdown**\n\n```ts\nconst shared = true\n```' }],
      },
      {
        kind: 'assistant', seq: 2, time: 2, turn: 1, step: 1,
        blocks: [{
          kind: 'image',
          attachment: {
            attachmentId: 'shared-image' as never,
            mediaType: 'image/gif', bytes: 35, width: 1, height: 1, name: 'shared.gif',
          },
        }],
      },
      toolNode('edit', 'call-edit', 3, {
        card: 'diff',
        diffs: [{ path: 'src/shared.ts', oldText: 'const shared = false', newText: 'const shared = true' }],
      }),
      toolNode('future_tool', 'call-future', 4, null),
      { kind: 'turn-error', seq: 5, time: 5, turn: 1, step: 1, message: 'Host refused', code: 'HOST_400' },
      { kind: 'future-card', seq: 6, time: 6, payload: { label: 'Future conversation node' } } as never,
    ],
    turnTimings: [],
    turnEnds: [],
    partial: mode === 'live'
      ? { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'LIVE_PUSH_OK' }] }
      : null,
    runningCalls: mode === 'approval'
      ? [{
        callId: 'approval-call', name: 'bash', argsRaw: JSON.stringify({ command: LONG_TEXT }),
        turn: 2, step: 1, time: 7, callView: null, subCalls: [],
      }]
      : [],
    pending: mode === 'approval'
      ? [{
        kind: 'approval', interactionId: 'approval-product-entry', sessionId: SESSION_ID,
        payload: {
          approvalId: 'approval-product-entry' as never,
          toolName: 'bash', callId: 'approval-call' as never, reason: LONG_TEXT,
        },
      }]
      : mode === 'question'
        ? [{
          kind: 'question', interactionId: 'question-product-entry', sessionId: SESSION_ID,
          payload: {
            questions: [{
              id: 'continue', question: 'Continue shared delivery?',
              options: [{ label: 'Yes', description: 'Continue the authenticated flow.' }],
            }],
          },
        }]
        : [],
    queue: [],
    running: mode === 'approval',
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
}

function toolNode(
  name: string,
  callId: string,
  seq: number,
  resultView: Record<string, unknown> | null,
): ValidatedDesktopSurfaceResync['conversations'][number]['nodes'][number] {
  return {
    kind: 'tool-result', seq, time: seq, callId,
    call: { name, argsRaw: name === 'edit' ? '{"file_path":"src/shared.ts"}' : '{"future":true}' },
    callTime: seq - 0.5,
    content: [{ type: 'text', text: `${name} complete` }],
    isError: false,
    callView: null,
    resultView: resultView as never,
    subCalls: [],
  }
}
