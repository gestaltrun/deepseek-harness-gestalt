/**
 * Side Chat routes of the /sidebar JSON API.
 *
 * A side thread is a child session the plugin creates ITSELF with a custom
 * seed — the parent's full event log up to the first-submit moment, honestly closed
 * at an in-progress turn (see sidechat-core.ts). The child is marked
 * `origin: 'subagent'` so the main session list hides it, and EVERY
 * operation goes through these routes because the generic session RPCs are
 * fenced away from subagent-origin identities (the api-remotes
 * agent-lookup ownership fence):
 *
 * - creation uses the public AgentRegistry.create seam (the same one
 *   api-proxy's session.fork and the subagent fork provider use), with the
 *   parent's preset composition and provider/model selection so the child's
 *   first request shares the parent's token prefix (provider-side prefix
 *   cache reuse);
 * - the first prompt (boundary + question) uses `agent.followup`; later input
 *   preserves the canonical composer's queue/steer choice;
 * - a cold thread (DSH restart, or a closed thread) is resumed with
 *   AgentRegistry.resume, composing the preset the child recorded.
 */
import {
  createUserMessage, freezeMessage, MessageId, ReasoningEffortId,
  type ContentBlock, type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  installModelSelection, liveModelSelection,
  type Agent, type AgentSetup, type CreateAgentOptions, type ModelSelection,
  type ModelSelectionRef, type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  Context,
  SidebarAgentPresetsService,
  SidebarSessionPersistenceService,
  SidebarSessionTitleService,
} from './context-types.ts'
import {
  boundaryDelivered,
  buildSidechatInheritance,
  resolvePresetId,
  SIDE_BOUNDARY_PROMPT,
  SIDE_INJECTION_PLUGIN,
  sideLabel,
  type SeedEvent,
  type SidechatLogEvent,
} from './sidechat-core.ts'
import { requireString, SidebarError } from './wire.ts'

/** Side Chat routes of the sidebar API (wire method names). */
export interface SidechatRoutes {
  /** Create a child from the parent state at first-submit time and admit that prompt. */
  'sidechat.start'(payload: unknown): Promise<{ childId: string; accepted: true }>
  /** Deliver one queued or steering message to a thread (live, or cold-resumed). */
  'sidechat.prompt'(payload: unknown): Promise<{ accepted: true }>
  /** Read the draft, live child, or parent model selection and route availability. */
  'sidechat.model'(payload: unknown): Promise<{ current: ModelSelection; routable: boolean }>
  /** Validate and apply a model selection to a live child, or return it for a draft. */
  'sidechat.selectModel'(payload: unknown): Promise<{ selected: ModelSelection }>
  /** Abort the thread's running turn (queued work is preserved). */
  'sidechat.cancel'(payload: unknown): Promise<{ accepted: true }>
  /** Mutate one pending Side Chat queue item. */
  'sidechat.updateQueue'(payload: unknown): Promise<{ accepted: true }>
  /** Apply one permission preset to the Side Chat and its direct parent. */
  'sidechat.permission'(payload: unknown): Promise<{ selected: string }>
  /** Release the thread's live agent (session and history stay persisted). */
  'sidechat.dispose'(payload: unknown): Promise<{ accepted: true }>
}

type SidechatQueueAction =
  | { kind: 'edit'; content: ContentBlock[] }
  | { kind: 'remove' }
  | { kind: 'steer' }

/** Parse the private route's untrusted queue action. */
function queueActionOf(payload: unknown): SidechatQueueAction {
  const action = typeof payload === 'object' && payload !== null
    ? (payload as { action?: unknown }).action
    : undefined
  if (typeof action !== 'object' || action === null || !('kind' in action)) {
    throw new SidebarError('bad-request', 'invalid queue action')
  }
  const record = action as { kind?: unknown; content?: unknown }
  if (record.kind === 'remove' || record.kind === 'steer') return { kind: record.kind }
  if (record.kind !== 'edit' || !Array.isArray(record.content)) {
    throw new SidebarError('bad-request', 'invalid queue action')
  }
  const content = record.content.map((block) => {
    if (typeof block !== 'object' || block === null
      || (block as { type?: unknown }).type !== 'text'
      || typeof (block as { text?: unknown }).text !== 'string') {
      throw new SidebarError('bad-request', 'queue edits accept text content only')
    }
    return { type: 'text' as const, text: (block as { text: string }).text }
  })
  return { kind: 'edit', content }
}

/** Apply one canonical queue mutation to the Side Chat's live Agent. */
function updateThreadQueue(agent: Agent, itemId: string, action: SidechatQueueAction): void {
  const id = MessageId(itemId)
  const target = agent.inbox.nextTurn.some(message => message.id === id)
    ? 'next-turn'
    : agent.inbox.nextStep.some(message => message.id === id) ? 'next-step' : undefined
  const messages = target === 'next-turn'
    ? agent.inbox.nextTurn
    : target === 'next-step' ? agent.inbox.nextStep : undefined
  const message = messages?.find(candidate => candidate.id === id)
  if (target === undefined || message === undefined) {
    throw new SidebarError('queue-item-not-found', 'queued item is no longer pending', 409)
  }
  if (action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
    throw new SidebarError('steer-unavailable', 'current turn no longer accepts steering', 409)
  }
  if (action.kind === 'edit') {
    agent.inbox.replace(id, freezeMessage({ ...message, content: action.content }))
    return
  }
  agent.inbox.remove(id)
  if (action.kind === 'steer') agent.steer(message)
}

interface SidechatPermissionService {
  readonly names: readonly string[]
  setAgent(agent: Agent, name: string): void
}

/** Activation-owned routes and the quiescent teardown for their live Agent handles. */
export interface SidechatApi {
  /** Routes mounted under `/sidebar/api`. */
  routes: SidechatRoutes
  /** Stop admission, wait for admitted calls, and release every live Agent handle. */
  dispose(): Promise<void>
}

/** Timeout guarding the create call (the registry detaches it before the
 *  handle becomes visible, so the child is never cancelled by it). */
const CREATE_TIMEOUT_MS = 15_000

/** Parse the model selection submitted by the browser. */
function modelSelectionOf(value: unknown): {
  provider: string
  model: string
  reasoningEffort?: string
} | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new SidebarError('bad-request', 'invalid "selection"')
  const record = value as Record<string, unknown>
  if (typeof record.provider !== 'string' || typeof record.model !== 'string') {
    throw new SidebarError('bad-request', 'selection provider and model are required')
  }
  if (record.reasoningEffort !== undefined && typeof record.reasoningEffort !== 'string') {
    throw new SidebarError('bad-request', 'invalid selection reasoningEffort')
  }
  return {
    provider: record.provider,
    model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
  }
}

/** Resolve one requested route through the mounted LLM registry. */
async function resolveModelSelection(
  ctx: Context,
  selection: { provider: string; model: string; reasoningEffort?: string },
): Promise<ModelSelection> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new SidebarError('sidechat-error', 'model selection is unavailable', 503)
  try {
    const resolved = await llm.resolveCallConfig({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
    })
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  } catch (error) {
    throw new SidebarError(
      'sidechat-error',
      error instanceof Error ? error.message : String(error),
      409,
    )
  }
}

/** Current model route for a live parent or Side Chat child. */
function currentModelSelection(agent: Agent): ModelSelection {
  const selected = liveModelSelection(agent)
  if (selected !== undefined) return selected
  if (agent.options.provider === undefined || agent.options.model === undefined) {
    throw new SidebarError('sidechat-error', `session "${agent.id}" has no model selection`, 409)
  }
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Mount the model-selection ref inside the unpublished Agent scope. */
function withModelSelection(
  base: AgentSetup,
  selection: ModelSelectionRef,
): AgentSetup {
  return async (agentCtx) => {
    await base(agentCtx)
    agentCtx.effect(
      () => installModelSelection(agentCtx, selection),
      'dsh-better-sidebar: Side Chat model selection',
    )
  }
}

/** Resolve the parent's preset and build the child's composition setup. */
async function composeChildSetup(
  ctx: Context,
  presetId: string | undefined,
): Promise<{ agentPreset?: string; setup: AgentSetup }> {
  const presets = ctx.get('agentPresets') as SidebarAgentPresetsService | undefined
  if (presets === undefined) {
    return { setup: () => Promise.resolve() }
  }
  const resolved = await presets.resolve(presetId)
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx: CordisContext) => { await presets.mount(agentCtx, resolved.id) },
  }
}

/** Build the cold-resume setup from the thread's PERSISTED record (the
 *  recorded preset wins, newest selection event first). */
async function composePersistedSetup(
  ctx: Context,
  childId: string,
): Promise<AgentSetup> {
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence === undefined) {
    return () => Promise.resolve()
  }
  const inspected = await persistence.inspect(childId)
  const presetId = resolvePresetId(inspected.meta, inspected.events)
  const presets = ctx.get('agentPresets') as SidebarAgentPresetsService | undefined
  if (presets === undefined || presetId === undefined) {
    return () => Promise.resolve()
  }
  const resolved = await presets.resolve(presetId)
  return async (agentCtx: CordisContext) => { await presets.mount(agentCtx, resolved.id) }
}

/** One text-block prompt (the thread boundary + question, or a follow-up). */
function textPrompt(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Deliver one user message at the requested inbox boundary. */
function admitPrompt(agent: Agent, blocks: ContentBlock[], mode: 'queue' | 'steer'): void {
  const message: UserMessage = createUserMessage({ content: blocks, source: { kind: 'user' } })
  if (mode === 'steer') agent.steer(message)
  else agent.followup(message)
}

/**
 * Deliver the thread's FIRST contact as TWO log-separated messages: the
 * boundary prompt (+ the parked in-progress snapshot) rides `agent.inject`
 * — queued model-facing context that does NOT wake the driver and is
 * claimed FIRST at the opening step (Inbox.claim drains next-step before
 * next-turn) — and the user's question is the follow-up that wakes it. The
 * log therefore records two user/message events (injection, then question)
 * instead of one wrapped blob: the transcript shows the question as a user
 * bubble and collapses the injection as a context row. The injection source
 * is stamped `kind: 'plugin'` so recognition is structural; its text still
 * opens with SIDE_BOUNDARY_PREFIX, keeping boundaryDelivered intact.
 */
function admitFirstContact(agent: Agent, injectionText: string, question: string): void {
  agent.inject(createUserMessage({
    content: textPrompt(injectionText),
    source: { kind: 'plugin', plugin: SIDE_INJECTION_PLUGIN },
  }))
  admitPrompt(agent, textPrompt(question), 'queue')
}

/** The live thread agent, or undefined (cold — the caller resumes). */
function liveThreadAgent(ctx: Context, childId: string): Agent | undefined {
  const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
  return agents?.get(childId)
}

/** Build the Side Chat routes (all optional services degrade to a wire
 *  error the tab surfaces inline). The record keys are the FULL wire method
 *  names the /sidebar/api dispatcher looks up (`api[method]`). */
export function buildSidechatApi(ctx: Context): SidechatApi {
  /** Disposers of thread agents created by this activation. */
  const threadDisposers = new Map<string, () => Promise<void>>()
  /** Mutable selections installed into live Side Chat Agent scopes. */
  const threadSelections = new Map<string, ModelSelectionRef>()
  const inFlight = new Set<Promise<void>>()
  let stopping = false
  let teardown: Promise<void> | undefined

  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopping) return Promise.reject(new SidebarError('sidechat-error', 'side chat is stopping', 503))
    const result = operation()
    const settled = result.then(() => undefined, () => undefined)
    inFlight.add(settled)
    void settled.finally(() => { inFlight.delete(settled) })
    return result
  }

  const rawRoutes: SidechatRoutes = {
    'sidechat.start': async (payload: unknown) => {
      const sessionId = requireString(payload, 'sessionId')
      const childId = requireString(payload, 'childId') as SessionId
      const text = requireString(payload, 'text').trim()
      if (text === '') throw new SidebarError('bad-request', 'text is required')
      const parent = liveThreadAgent(ctx, sessionId)
      if (parent === undefined) {
        throw new SidebarError('sidechat-error', `parent session "${sessionId}" is not running`, 409)
      }
      const parentSession = parent.session
      const inheritance = buildSidechatInheritance(
        parentSession.events as unknown as readonly SidechatLogEvent[],
      )
      const { agentPreset, setup } = await composeChildSetup(
        ctx,
        resolvePresetId(parentSession.header, parentSession.events),
      )
      const requestedSelection = modelSelectionOf((payload as { selection?: unknown }).selection)
      const selected = requestedSelection === undefined
        ? currentModelSelection(parent)
        : await resolveModelSelection(ctx, requestedSelection)
      const selectionRef: ModelSelectionRef = { current: selected, assembled: undefined }
      const label = sideLabel(text)
      // Honest catalog citizenship: the durable descriptor keeps the thread
      // a HEALTHY row in the host's subagents.list — a cold child without
      // one is deterministically rendered as a 'corrupt' diagnostic. The
      // SubagentView filters the 'Side: ' label out, so the topology UI
      // stays noise-free; the row only serves enumeration correctness.
      const descriptor = snapshotSubagentDescriptor({
        mode: 'continuable',
        provider: 'sidechat',
        label,
        agentProvider: selected.provider,
        agentModel: selected.model,
      })
      const descriptorEvent: SeedEvent = {
        type: 'subagent/descriptor',
        seq: inheritance.seed.length,
        time: Date.now(),
        data: descriptor as unknown as Record<string, unknown>,
      }
      const seed = [...inheritance.seed, descriptorEvent]
      const options: CreateAgentOptions = {
        sessionId: childId,
        meta: {
          ...(parentSession.header.cwd === undefined ? {} : { cwd: parentSession.header.cwd }),
          parentSession: parentSession.id,
          seedLength: seed.length,
          origin: 'subagent',
          delegationDepth: (parentSession.header.delegationDepth ?? 0) + 1,
          ...(agentPreset === undefined ? {} : { agentPreset }),
        },
        seed: seed as unknown as readonly SessionEvent[],
        agentOptions: { ...parent.options, provider: selected.provider, model: selected.model },
        setup: withModelSelection(setup, selectionRef),
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      }
      const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<{ agent: Agent; dispose(): Promise<void> }> } | undefined
      if (agents?.create === undefined) {
        throw new SidebarError('sidechat-error', 'the agents service is unavailable', 503)
      }
      threadSelections.set(childId, selectionRef)
      let handle: { agent: Agent; dispose(): Promise<void> }
      try {
        handle = await agents.create(options)
      } catch (error) {
        threadSelections.delete(childId)
        throw new SidebarError('sidechat-error', `thread creation failed: ${error instanceof Error ? error.message : String(error)}`, 500)
      }
      threadDisposers.set(childId, () => handle.dispose())
      // Pin the thread label so the client can identify its threads by
      // title prefix (the rename is a live-session op, no RPC fence).
      const titles = ctx.get('sessionTitle') as SidebarSessionTitleService | undefined
      if (titles !== undefined) {
        try {
          titles.rename(handle.agent.session, label)
        } catch {
          // Keep the auto-generated title; the thread stays usable.
        }
      }
      const promptParts = [SIDE_BOUNDARY_PROMPT]
      if (inheritance.snapshot !== null) promptParts.push(inheritance.snapshot)
      admitFirstContact(handle.agent, promptParts.join('\n\n'), text)
      return { childId, accepted: true as const }
    },

    'sidechat.prompt': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const text = requireString(payload, 'text').trim()
      const rawMode = requireString(payload, 'mode')
      if (rawMode !== 'queue' && rawMode !== 'steer') {
        throw new SidebarError('bad-request', 'invalid "mode"')
      }
      if (text === '') {
        throw new SidebarError('bad-request', 'text is required')
      }
      let agent = liveThreadAgent(ctx, childId)
      if (agent === undefined) {
        // Cold thread: resume the persisted session under its recorded
        // composition, then deliver the follow-up.
        const agents = ctx.get('agents') as { resume(options: ResumeAgentOptions): Promise<{ agent: Agent; dispose(): Promise<void> }> } | undefined
        if (agents?.resume === undefined) {
          throw new SidebarError('sidechat-error', 'the agents service is unavailable', 503)
        }
        const baseSetup = await composePersistedSetup(ctx, childId)
        const selectionRef = threadSelections.get(childId)
          ?? { current: undefined, assembled: undefined }
        try {
          const handle = await agents.resume({
            resumeSessionId: childId as SessionId,
            setup: withModelSelection(baseSetup, selectionRef),
          })
          threadDisposers.set(childId, () => handle.dispose())
          threadSelections.set(childId, selectionRef)
          agent = handle.agent
        } catch (error) {
          throw new SidebarError('sidechat-error', `thread resume failed: ${error instanceof Error ? error.message : String(error)}`, 500)
        }
      }
      if (boundaryDelivered(agent.session.events as unknown as readonly SidechatLogEvent[])) {
        admitPrompt(agent, textPrompt(text), rawMode)
      } else {
        // Compatibility for persisted empty Side Chat Sessions created by an
        // earlier build: their first prompt still installs the boundary.
        admitFirstContact(agent, SIDE_BOUNDARY_PROMPT, text)
        const titles = ctx.get('sessionTitle') as SidebarSessionTitleService | undefined
        if (titles !== undefined) {
          try {
            titles.rename(agent.session, sideLabel(text))
          } catch {
            // Keep the placeholder title; the thread stays usable.
          }
        }
      }
      return { accepted: true as const }
    },

    'sidechat.model': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const parentSessionId = typeof (payload as { parentSessionId?: unknown }).parentSessionId === 'string'
        ? (payload as { parentSessionId: string }).parentSessionId
        : undefined
      const retained = threadSelections.get(childId)?.current
      const agent = liveThreadAgent(ctx, childId)
        ?? (parentSessionId === undefined ? undefined : liveThreadAgent(ctx, parentSessionId))
      let current = retained
      if (current === undefined) {
        if (agent === undefined) {
          throw new SidebarError('sidechat-error', `model owner for "${childId}" is unavailable`, 409)
        }
        current = currentModelSelection(agent)
      }
      const llm = ctx.get('llm')
      const routable = llm === undefined || llm.listProviders().some(provider => provider.id === current.provider)
      return { current, routable }
    },

    'sidechat.selectModel': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const requested = modelSelectionOf((payload as { selection?: unknown }).selection)
      if (requested === undefined) throw new SidebarError('bad-request', 'selection is required')
      const selected = await resolveModelSelection(ctx, requested)
      const agent = liveThreadAgent(ctx, childId)
      const provisional = (payload as { provisional?: unknown }).provisional === true
      if (agent === undefined && provisional) return { selected }
      if (agent === undefined) {
        const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
        if (persistence === undefined) {
          throw new SidebarError('sidechat-error', 'persisted Side Chat lookup is unavailable', 503)
        }
        try {
          await persistence.inspect(childId)
        } catch (error) {
          throw new SidebarError(
            'sidechat-error',
            `thread model selection failed: ${error instanceof Error ? error.message : String(error)}`,
            404,
          )
        }
      }
      let selection = threadSelections.get(childId)
      if (agent !== undefined) {
        if (selection === undefined) {
          selection = { current: currentModelSelection(agent), assembled: undefined }
          threadSelections.set(childId, selection)
          const installed = selection
          agent.ctx.effect(
            () => installModelSelection(agent.ctx, installed),
            'dsh-better-sidebar: Side Chat model selection',
          )
        }
      }
      selection ??= { current: undefined, assembled: undefined }
      selection.current = selected
      threadSelections.set(childId, selection)
      return { selected }
    },

    'sidechat.cancel': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const agent = liveThreadAgent(ctx, childId)
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
      return { accepted: true as const }
    },

    'sidechat.updateQueue': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const itemId = requireString(payload, 'itemId')
      const agent = liveThreadAgent(ctx, childId)
      if (agent === undefined) {
        throw new SidebarError('queue-item-not-found', 'queued item is no longer pending', 409)
      }
      updateThreadQueue(agent, itemId, queueActionOf(payload))
      return { accepted: true as const }
    },

    'sidechat.permission': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      const parentSessionId = requireString(payload, 'parentSessionId')
      const preset = requireString(payload, 'preset')
      const permissions = ctx.get('permissionPresets') as SidechatPermissionService | undefined
      if (permissions === undefined) {
        throw new SidebarError('sidechat-error', 'permission presets are unavailable', 503)
      }
      if (!permissions.names.includes(preset)) {
        throw new SidebarError('bad-request', `unknown permission preset "${preset}"`)
      }
      const parent = liveThreadAgent(ctx, parentSessionId)
      if (parent === undefined) {
        throw new SidebarError('sidechat-error', `parent session "${parentSessionId}" is not running`, 409)
      }
      const provisional = (payload as { provisional?: unknown }).provisional === true
      if (provisional) {
        permissions.setAgent(parent, preset)
        return { selected: preset }
      }
      const child = liveThreadAgent(ctx, childId)
      if (child === undefined) {
        throw new SidebarError('sidechat-error', `Side Chat session "${childId}" is not running`, 409)
      }
      if (child.session.header.parentSession !== parentSessionId) {
        throw new SidebarError('bad-request', 'Side Chat parent does not match the requested parent')
      }
      permissions.setAgent(parent, preset)
      permissions.setAgent(child, preset)
      return { selected: preset }
    },

    'sidechat.dispose': async (payload: unknown) => {
      const childId = requireString(payload, 'childId')
      threadSelections.delete(childId)
      const dispose = threadDisposers.get(childId)
      if (dispose !== undefined) {
        threadDisposers.delete(childId)
        try {
          await dispose()
        } catch {
          // The agent may already be gone (restart); the session persists.
        }
      }
      return { accepted: true as const }
    },

  }
  const routes: SidechatRoutes = {
    'sidechat.start': payload => admit(() => rawRoutes['sidechat.start'](payload)),
    'sidechat.prompt': payload => admit(() => rawRoutes['sidechat.prompt'](payload)),
    'sidechat.model': payload => admit(() => rawRoutes['sidechat.model'](payload)),
    'sidechat.selectModel': payload => admit(() => rawRoutes['sidechat.selectModel'](payload)),
    'sidechat.cancel': payload => admit(() => rawRoutes['sidechat.cancel'](payload)),
    'sidechat.updateQueue': payload => admit(() => rawRoutes['sidechat.updateQueue'](payload)),
    'sidechat.permission': payload => admit(() => rawRoutes['sidechat.permission'](payload)),
    'sidechat.dispose': payload => admit(() => rawRoutes['sidechat.dispose'](payload)),
  }
  const dispose = (): Promise<void> => {
    if (teardown !== undefined) return teardown
    stopping = true
    teardown = (async () => {
      await Promise.all([...inFlight])
      threadSelections.clear()
      const disposers = [...threadDisposers.values()]
      threadDisposers.clear()
      const results = await Promise.allSettled(disposers.map(async release => release()))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'side chat Agent teardown failed')
    })()
    return teardown
  }
  return { routes, dispose }
}
