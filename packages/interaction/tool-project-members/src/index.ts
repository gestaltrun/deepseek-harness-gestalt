/**
 * Model-facing Consumer of the project-membership capability seam. One
 * `project_members` read returns the full roster of a cloud project — each
 * member's account reference, public display identity, permission role,
 * project-defined function tags, and presence — with no role-based
 * restriction on querying.
 *
 * The acting account, the workspace→project binding, and the presence/identity
 * presentation never come from this package: a composition injects them as
 * Config resolver functions, and the platform provider face wires them to
 * `ctx.platformAccount`, the workspace remote, and the presence registry. The
 * package depends only on the membership Service Definition and stays free of
 * platform-package dependencies.
 * @module @deepseek-ai/dsh-tool-project-members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-project-membership'
import type { MemberView, ProjectRole, RosterView } from '@deepseek-ai/dsh-project-membership'
import z from '@deepseek-ai/schemastery'

/**
 * Durable platform account reference, resolvable only by the provider face.
 * Spelled through the shared brand key so a resolver typed against the
 * Account Service Definition's id is directly assignable here without this
 * package importing any platform package.
 */
export type AccountRef = Branded<'PlatformAccountId'>

/** Resolves the session-bound platform account that reads the roster. */
export type CurrentAccountResolver = (input?: {
  /** Agent making the tool call, when one is live. */
  readonly agent?: Agent
  /** Tool cancellation signal for provider I/O. */
  readonly signal?: AbortSignal
}) => Promise<AccountRef | undefined>

/** Resolves the workspace-bound cloud project for calls that omit `projectId`. */
export type BoundProjectResolver = (input?: {
  /** Agent whose immutable Session cwd selects the Workspace. */
  readonly agent?: Agent
  /** Tool cancellation signal for provider I/O. */
  readonly signal?: AbortSignal
}) => Promise<Branded<'ProjectId'> | undefined>

/** Provider face for compositions whose authoritative roster is behind another process boundary. */
export type RosterResolver = (
  actor: AccountRef,
  projectId: Branded<'ProjectId'>,
  input?: {
    /** Agent making the tool call, when one is live. */
    readonly agent?: Agent
    /** Tool cancellation signal for provider I/O. */
    readonly signal?: AbortSignal
  },
) => Promise<RosterView>

/** Whether any of a member's installations held a live heartbeat at the read. */
export type MemberPresence = 'online' | 'offline'

/** Presence and public display identity attached to one stored member. */
export interface MemberPresentation {
  /** Presence verdict of the composition's aggregation plane. */
  readonly presence: MemberPresence
  /** Current public display name; omitted when the composition does not resolve identities. */
  readonly displayName?: string
  /** Current public avatar reference; omitted when the composition does not resolve identities. */
  readonly avatarRef?: string
}

/**
 * Attaches presence and public display identity to one stored roster read.
 * Implementations return exactly one presentation per input member, in the
 * same order; the tool owns every stored roster field.
 */
export type RosterPresenter = (view: RosterView) => Promise<readonly MemberPresentation[]>

/** One roster member as the model receives it. */
export interface ProjectMemberView {
  /** Member's durable platform account reference. */
  readonly accountId: AccountRef
  /** Current public display name, when the composition resolves identities. */
  readonly displayName?: string
  /** Current public avatar reference, when the composition resolves identities. */
  readonly avatarRef?: string
  /** Permission role in the project's collaboration plane. */
  readonly role: ProjectRole
  /** Project-defined function tags; display and routing metadata, never permission-bearing. */
  readonly tags: string[]
  /** Whether the member holds a live presence at the read. */
  readonly presence: MemberPresence
}

/** Stable failure taxonomy of the `project_members` tool. */
export type ProjectMembersToolErrorCode = 'PROJECT_UNBOUND' | 'ACCOUNT_UNAVAILABLE'

/** Tool failure with a stable code safe for model and client branching. */
export class ProjectMembersToolError extends HarnessError {
  constructor(message: string, code: ProjectMembersToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ProjectMembersToolError'
  }
}

/** Pinned model-facing text for an unresolvable workspace→project binding. */
const PROJECT_UNBOUND_MESSAGE =
  'PROJECT_UNBOUND: no cloud project is bound to this workspace; link the workspace to a project or pass projectId explicitly'

/** Pinned model-facing text for an unresolvable session-bound account. */
const ACCOUNT_UNAVAILABLE_MESSAGE =
  'ACCOUNT_UNAVAILABLE: no account is bound to the current session; sign in before querying project members'

/**
 * Model-facing tool configuration: the injected provider faces. A call
 * resolves the account first and the workspace binding second, so a
 * composition with neither face answers `ACCOUNT_UNAVAILABLE`.
 */
export interface Config {
  /**
   * Resolves the current session-bound account; the platform provider face
   * wires it to the Account Service Definition. Absent, rejecting, or
   * resolving to undefined answers the stable `ACCOUNT_UNAVAILABLE` error.
   */
  currentAccountResolver?: CurrentAccountResolver
  /**
   * Resolves the workspace-bound cloud project for calls that omit
   * `projectId`; a workspace-face resolver derives it from the workspace
   * remote. Absent, rejecting, or resolving to undefined answers the stable
   * `PROJECT_UNBOUND` error.
   */
  boundProjectResolver?: BoundProjectResolver
  /**
   * Attaches presence and public display identity to one read; the platform
   * provider face wires it to the presence registry and public identities.
   * Absent, every member reads `offline` with no identity fields — the same
   * verdict a composed presence registry with no live heartbeats produces.
   */
  rosterPresenter?: RosterPresenter
  /**
   * Reads the canonical roster through a composition-owned authenticated bridge.
   * Absent, the tool uses `ctx.projectMembership.roster()` as before.
   */
  rosterResolver?: RosterResolver
}

/** Schemastery configuration for the tool consumer. */
export const Config: z<Config> = z.object({
  currentAccountResolver: z.any(),
  boundProjectResolver: z.any(),
  rosterPresenter: z.any(),
  rosterResolver: z.any(),
})

/** Config keys whose injected values must be callable. */
const RESOLVER_KEYS = ['currentAccountResolver', 'boundProjectResolver', 'rosterPresenter', 'rosterResolver'] as const

/**
 * Validate the injected faces loudly for both Loader-normalized and
 * programmatic construction, so misconfiguration fails at load.
 * @param config - raw plugin config.
 * @returns the same config once every present resolver is callable.
 */
function resolveConfig(config: Config): Config {
  for (const key of RESOLVER_KEYS) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'function') {
      throw new TypeError(`tool-project-members: config.${key} must be a resolver function`)
    }
  }
  return config
}

const TOOL_DESCRIPTION =
  'Query the roster of a cloud project: every member with their account reference, display name, '
  + 'avatar, permission role, function tags, and presence. '
  + 'Omit projectId to query the project bound to the current workspace. '
  + 'Use it when coordination, review, or task routing needs to know who is on the project, what each member covers, and who is online.'

/** Cordis plugin name. */
export const name = 'tool-project-members'
/** Required tool registry; roster authority comes from the Service Definition or an injected bridge resolver. */
export const inject = ['tools']

/**
 * Register the `project_members` tool on `ctx.tools`.
 * @param ctx - composition context carrying the tool registry and the membership service.
 * @param config - injected provider faces; every field is optional.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.tools.register(defineTool({
    name: 'project_members',
    description: TOOL_DESCRIPTION,
    parameters: {
      projectId: {
        type: 'string',
        description: 'Cloud project to query; omit to read the project bound to the current workspace.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accountId: { type: 'string', required: true },
            displayName: { type: 'string' },
            avatarRef: { type: 'string' },
            role: { type: 'string', required: true, enum: ['owner', 'admin', 'member'] },
            tags: { type: 'array', required: true, items: { type: 'string' } },
            presence: { type: 'string', required: true, enum: ['online', 'offline'] },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const actor = await resolveActor(resolved, exec.agent, exec.signal)
      const projectId = await resolveProjectId(args, resolved, exec.agent, exec.signal)
      const rosterResolver = resolved.rosterResolver
      const membership = ctx.get('projectMembership')
      let view
      if (rosterResolver !== undefined) {
        view = await rosterResolver(actor, projectId, {
          ...exec.agent === undefined ? {} : { agent: exec.agent },
          signal: exec.signal,
        })
      } else if (membership === undefined) {
        throw new Error('tool-project-members: no project-membership roster provider is composed')
      } else {
        view = await membership.roster(actor, projectId)
      }
      return toMemberViews(view, resolved)
    },
  }))
}

/**
 * Resolve the queried project: an explicit `projectId` wins; otherwise the
 * workspace binding decides, and an unresolvable binding answers the stable
 * `PROJECT_UNBOUND` error with the underlying cause chained.
 * @param args - schema-validated tool arguments.
 * @param config - injected provider faces.
 * @returns the branded project id for the roster read.
 * @throws {ProjectMembersToolError} `PROJECT_UNBOUND` when no binding resolves.
 */
async function resolveProjectId(
  args: { projectId?: string },
  config: Config,
  agent?: Agent,
  signal?: AbortSignal,
): Promise<Branded<'ProjectId'>> {
  if (args.projectId !== undefined) return args.projectId as Branded<'ProjectId'>
  try {
    const bound = await config.boundProjectResolver?.({
      ...agent === undefined ? {} : { agent },
      ...signal === undefined ? {} : { signal },
    })
    if (bound !== undefined) return bound
  } catch (cause: unknown) {
    throw new ProjectMembersToolError(PROJECT_UNBOUND_MESSAGE, 'PROJECT_UNBOUND', { cause })
  }
  throw new ProjectMembersToolError(PROJECT_UNBOUND_MESSAGE, 'PROJECT_UNBOUND')
}

/**
 * Resolve the acting account, answering the stable `ACCOUNT_UNAVAILABLE`
 * error when no account is bound or resolution fails, with the underlying
 * cause chained.
 * @param config - injected provider faces.
 * @returns the branded account id for the roster read.
 * @throws {ProjectMembersToolError} `ACCOUNT_UNAVAILABLE` when no account resolves.
 */
async function resolveActor(config: Config, agent?: Agent, signal?: AbortSignal): Promise<AccountRef> {
  try {
    const account = await config.currentAccountResolver?.({
      ...agent === undefined ? {} : { agent },
      ...signal === undefined ? {} : { signal },
    })
    if (account !== undefined) return account
  } catch (cause: unknown) {
    throw new ProjectMembersToolError(ACCOUNT_UNAVAILABLE_MESSAGE, 'ACCOUNT_UNAVAILABLE', { cause })
  }
  throw new ProjectMembersToolError(ACCOUNT_UNAVAILABLE_MESSAGE, 'ACCOUNT_UNAVAILABLE')
}

/**
 * Map the stored roster onto the model-facing member views. Without an
 * injected presenter every member reads `offline` with no identity fields;
 * with one, presentation count and order follow the stored member order.
 * @param view - roster as the membership service stores it.
 * @param config - injected provider faces.
 * @returns the complete member array, never a partial roster.
 */
async function toMemberViews(view: RosterView, config: Config): Promise<ProjectMemberView[]> {
  const presentations = config.rosterPresenter
    ? await config.rosterPresenter(view)
    : view.members.map(() => ({ presence: 'offline' as const }))
  const members: ProjectMemberView[] = []
  for (const [index, member] of view.members.entries()) {
    const presentation = presentations[index] ?? { presence: 'offline' as const }
    members.push(toMemberView(member, presentation))
  }
  return members
}

/**
 * Project one stored member onto the model-facing view; stored authority
 * (account, role, tags) stays authoritative, presentation fields decorate.
 * @param member - stored membership row.
 * @param presentation - presence and identity fields for this member.
 * @returns the model-facing member view.
 */
function toMemberView(member: MemberView, presentation: MemberPresentation): ProjectMemberView {
  return {
    accountId: member.accountId,
    ...presentation.displayName !== undefined ? { displayName: presentation.displayName } : {},
    ...presentation.avatarRef !== undefined ? { avatarRef: presentation.avatarRef } : {},
    role: member.role,
    tags: [...member.tags],
    presence: presentation.presence,
  }
}
